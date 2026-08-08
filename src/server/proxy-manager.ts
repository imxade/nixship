import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import net from "node:net";
import type { Duplex } from "node:stream";
import { domainToASCII } from "node:url";
import { getDb } from "./db.ts";
import { logger } from "./logger.ts";
import type { AppRow } from "./types.ts";

interface Listener {
  port: number;
  server: http.Server;
  sockets: Set<Socket>;
}

export const APPLICATION_PROXY_READY_HEADER = "x-platform-application-proxy";
export const APPLICATION_PROXY_READY_VALUE = "ready";

export class ProxyManager {
  private readonly listeners = new Map<string, Listener>();

  proxyDomainRequest(request: IncomingMessage, response: ServerResponse): boolean {
    const appId = this.domainAppId(request);
    if (!appId) return false;
    this.proxyHttp(appId, request, response);
    return true;
  }

  proxyDomainUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const appId = this.domainAppId(request);
    if (!appId) return false;
    this.proxyUpgrade(appId, request, socket, head);
    return true;
  }

  async reconcile(): Promise<void> {
    const apps = getDb()
      .prepare("SELECT * FROM applications WHERE kind = 'web' AND public_port IS NOT NULL")
      .all() as AppRow[];
    const expected = new Set(apps.map((app) => app.id));
    for (const app of apps) {
      const existing = this.listeners.get(app.id);
      if (existing?.port === app.public_port) continue;
      if (existing) await this.closeListener(app.id);
      if (app.public_port) await this.openListener(app.id, app.public_port);
    }
    for (const appId of this.listeners.keys()) {
      if (!expected.has(appId)) await this.closeListener(appId);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.listeners.keys()].map((appId) => this.closeListener(appId)));
  }

  private async openListener(appId: string, port: number): Promise<void> {
    const sockets = new Set<Socket>();
    const server = http.createServer((request, response) =>
      this.proxyHttp(appId, request, response),
    );
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) =>
      this.proxyUpgrade(appId, request, socket, head),
    );
    server.requestTimeout = 0;
    server.headersTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.listeners.set(appId, { port, server, sockets });
    logger.info("Application LAN proxy listening", { appId, port });
  }

  private async closeListener(appId: string): Promise<void> {
    const listener = this.listeners.get(appId);
    if (!listener) return;
    this.listeners.delete(appId);
    for (const socket of listener.sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.server.close(() => resolve()));
  }

  private targetPort(appId: string): number | null {
    const row = getDb()
      .prepare("SELECT active_internal_port, desired_state FROM applications WHERE id = ?")
      .get(appId) as { active_internal_port: number | null; desired_state: string } | undefined;
    return row?.desired_state === "running" ? row.active_internal_port : null;
  }

  private domainAppId(request: IncomingMessage): string | null {
    const hostname = requestHostname(request.headers.host);
    if (!hostname) return null;
    const row = getDb()
      .prepare("SELECT app_id FROM application_domains WHERE hostname = ?")
      .get(hostname) as { app_id: string } | undefined;
    return row?.app_id ?? null;
  }

  private proxyHttp(appId: string, request: IncomingMessage, response: ServerResponse): void {
    const port = this.targetPort(appId);
    if (!port) {
      response.writeHead(503, {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": "5",
        [APPLICATION_PROXY_READY_HEADER]: APPLICATION_PROXY_READY_VALUE,
      });
      response.end("Application unavailable\n");
      return;
    }

    const headers = stripHopByHopHeaders(request.headers);
    const clientIp = forwardedClientIp(request);
    delete headers["cf-connecting-ip"];
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];
    headers.host = request.headers.host;
    headers["x-forwarded-for"] = clientIp;
    headers["x-forwarded-host"] = firstHeader(request.headers.host) ?? "";
    headers["x-forwarded-proto"] = isEncryptedSocket(request.socket) ? "https" : "http";
    if (isLoopback(request.socket.remoteAddress)) headers["cf-connecting-ip"] = clientIp;

    const upstream = http.request(
      {
        host: "127.0.0.1",
        port,
        method: request.method,
        path: request.url,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = stripHopByHopHeaders(upstreamResponse.headers);
        responseHeaders[APPLICATION_PROXY_READY_HEADER] = APPLICATION_PROXY_READY_VALUE;
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent)
        response.writeHead(502, {
          "content-type": "text/plain; charset=utf-8",
          [APPLICATION_PROXY_READY_HEADER]: APPLICATION_PROXY_READY_VALUE,
        });
      response.end("Upstream application connection failed\n");
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  }

  private proxyUpgrade(
    appId: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const port = this.targetPort(appId);
    if (!port) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, "127.0.0.1", () => {
      const headerLines = [
        `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`,
      ];
      const denied = new Set([
        "proxy-authorization",
        "proxy-authenticate",
        "proxy-connection",
        "cf-connecting-ip",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
      ]);
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index] ?? "";
        const value = request.rawHeaders[index + 1] ?? "";
        if (!name || denied.has(name.toLowerCase())) continue;
        headerLines.push(`${name}: ${value}`);
      }
      const clientIp = forwardedClientIp(request);
      headerLines.push(`X-Forwarded-For: ${clientIp}`);
      headerLines.push(`X-Forwarded-Host: ${request.headers.host ?? ""}`);
      headerLines.push(
        `X-Forwarded-Proto: ${isEncryptedSocket(request.socket) ? "https" : "http"}`,
      );
      if (isLoopback(request.socket.remoteAddress)) {
        headerLines.push(`CF-Connecting-IP: ${clientIp}`);
      }
      upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function stripHopByHopHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const denied = new Set(HOP_BY_HOP_HEADERS);
  const connection = firstHeader(headers.connection);
  for (const token of connection?.split(",") ?? []) {
    const normalized = token.trim().toLowerCase();
    if (normalized) denied.add(normalized);
  }

  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || denied.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isEncryptedSocket(socket: Duplex): boolean {
  return Boolean((socket as Duplex & { encrypted?: boolean }).encrypted);
}

function forwardedClientIp(request: IncomingMessage): string {
  const remoteAddress = request.socket.remoteAddress ?? "";
  if (!isLoopback(remoteAddress)) return remoteAddress;
  return (
    firstHeader(request.headers["cf-connecting-ip"]) ??
    firstHeader(request.headers["x-forwarded-for"])?.split(",")[0]?.trim() ??
    remoteAddress
  );
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function requestHostname(host: string | undefined): string | null {
  if (!host) return null;
  const withoutPort = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.replace(/:\d+$/, "");
  const ascii = domainToASCII(withoutPort.replace(/\.$/, "")).toLowerCase();
  return ascii.length > 0 && ascii.includes(".") && net.isIP(ascii) === 0 ? ascii : null;
}
