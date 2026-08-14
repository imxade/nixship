import http from "node:http";
import type { Duplex } from "node:stream";
import next from "next";
import { config } from "./src/server/config.ts";
import { events } from "./src/server/events.ts";
import { logger } from "./src/server/logger.ts";
import { lanHttpUrls } from "./src/server/network.ts";
import { parseQuickTunnelUrl } from "./src/server/quick-tunnel-url.ts";
import { bootRuntime } from "./src/server/runtime.ts";
import { currentSetupToken, firstRunSetupUrl } from "./src/server/setup-links.ts";

const development = process.env.NODE_ENV !== "production";
const app = next({ dev: development, hostname: config.HOSTNAME, port: config.PORT });
const handle = app.getRequestHandler();

await app.prepare();
const handleUpgrade = app.getUpgradeHandler();
let platformRuntime: Awaited<ReturnType<typeof bootRuntime>>;
try {
  platformRuntime = await bootRuntime();
} catch (error) {
  await app.close().catch(() => undefined);
  throw error;
}
const loggedSetupOrigins = new Set<string>();

function logSetupLink(label: string, baseUrl: string): void {
  const token = currentSetupToken();
  if (!token || loggedSetupOrigins.has(baseUrl)) return;
  loggedSetupOrigins.add(baseUrl);
  logger.setupLink(label, firstRunSetupUrl(baseUrl, token));
}

function logDashboardQuickSetupLink(): void {
  const route = platformRuntime.quickTunnels
    .status()
    .routes.find((candidate) => candidate.targetType === "dashboard");
  if (route?.running && route.url) logSetupLink("Quick Tunnel", route.url);
}

const unsubscribeEvents = events.subscribe((event) => {
  if (event.type === "quick_tunnel.ready" && event.scope === "system") {
    logDashboardQuickSetupLink();
  }
});

const server = http.createServer((request, response) => {
  sanitizeForwardedHeaders(request);
  if (platformRuntime.proxy.proxyDomainRequest(request, response)) return;
  void handle(request, response).catch((error: unknown) => {
    logger.error("Unhandled Next.js request error", {
      error: error instanceof Error ? error.message : String(error),
      path: requestPath(request.url),
    });
    if (!response.headersSent)
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Internal server error\n");
  });
});
const upgradedSockets = new Set<Duplex>();
server.on("upgrade", (request, socket, head) => {
  upgradedSockets.add(socket);
  socket.once("close", () => upgradedSockets.delete(socket));
  if (platformRuntime.proxy.proxyDomainUpgrade(request, socket, head)) return;
  sanitizeForwardedHeaders(request);
  allowSameOriginQuickTunnelHmr(request);
  void handleUpgrade(request, socket, head).catch((error: unknown) => {
    logger.error("Unhandled Next.js upgrade error", {
      error: error instanceof Error ? error.message : String(error),
      path: requestPath(request.url),
    });
    socket.destroy();
  });
});

function requestPath(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url, "http://platform.local").pathname;
  } catch {
    return "invalid";
  }
}

server.requestTimeout = 120_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.listen(config.PORT, config.HOSTNAME, () => {
  logger.info("Nix Ship dashboard listening", {
    address: `http://${config.HOSTNAME}:${config.PORT}`,
    environment: process.env.NODE_ENV,
  });
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.HOSTNAME);
  const lanUrls = loopback ? [] : lanHttpUrls(config.PORT);
  if (lanUrls.length > 0) {
    for (const url of lanUrls) logSetupLink("LAN", url);
  } else {
    const configuredHost =
      config.HOSTNAME === "0.0.0.0"
        ? "127.0.0.1"
        : config.HOSTNAME === "::"
          ? "[::1]"
          : config.HOSTNAME.includes(":")
            ? `[${config.HOSTNAME}]`
            : config.HOSTNAME;
    logSetupLink("Local", `http://${configuredHost}:${config.PORT}`);
  }
  logDashboardQuickSetupLink();
});

function sanitizeForwardedHeaders(request: http.IncomingMessage): void {
  const remoteAddress = request.socket.remoteAddress ?? "unknown";
  const loopback =
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
  if (!loopback) {
    delete request.headers["cf-connecting-ip"];
    delete request.headers["x-forwarded-for"];
    delete request.headers["x-forwarded-host"];
    delete request.headers["x-forwarded-proto"];
  }
  request.headers["x-platform-client-ip"] = remoteAddress;
}

function allowSameOriginQuickTunnelHmr(request: http.IncomingMessage): void {
  if (!development) return;
  if (requestPath(request.url) !== "/_next/hmr") return;
  const remoteAddress = request.socket.remoteAddress;
  if (
    remoteAddress !== "127.0.0.1" &&
    remoteAddress !== "::1" &&
    remoteAddress !== "::ffff:127.0.0.1"
  ) {
    return;
  }
  const host = request.headers.host;
  const rawOrigin = request.headers.origin;
  if (!host || typeof rawOrigin !== "string") return;
  const quickTunnelOrigin = parseQuickTunnelUrl(`https://${host}`);
  if (!quickTunnelOrigin) return;
  try {
    if (new URL(rawOrigin).origin.toLowerCase() !== quickTunnelOrigin) return;
  } catch {
    return;
  }
  delete request.headers.origin;
}

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutting down Nix Ship control plane", { signal, exitCode });

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out", { signal });
    server.closeAllConnections();
    process.exit(1);
  }, 30_000);
  forceExit.unref();

  const serverClosed = new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });

  try {
    await platformRuntime.close();
  } catch (error) {
    exitCode = 1;
    logger.error("Runtime shutdown failed", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
  unsubscribeEvents();
  for (const socket of upgradedSockets) socket.destroy();
  upgradedSockets.clear();
  server.closeAllConnections();
  await serverClosed;
  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error: error.stack ?? error.message });
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", {
    reason: reason instanceof Error ? reason.stack : String(reason),
  });
  void shutdown("unhandledRejection", 1);
});
