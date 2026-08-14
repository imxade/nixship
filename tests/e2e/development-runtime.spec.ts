import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test, type WebSocket } from "@playwright/test";

test("custom development server completes the Next.js HMR WebSocket upgrade", async ({ page }) => {
  let hmrSocket: WebSocket | undefined;
  let socketError: string | undefined;
  let resolveFrame: (() => void) | undefined;
  const receivedFrame = new Promise<void>((resolve) => {
    resolveFrame = resolve;
  });

  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.startsWith("/_next/hmr")) return;
    hmrSocket = socket;
    socket.on("framereceived", () => resolveFrame?.());
    socket.on("socketerror", (error) => {
      socketError = error;
      resolveFrame?.();
    });
  });

  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Claim this Nix Ship" })).toBeVisible();
  await expect.poll(() => hmrSocket?.url()).toContain("/_next/hmr");
  await Promise.race([
    receivedFrame,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("HMR WebSocket received no frames")), 10_000),
    ),
  ]);
  expect(socketError).toBeUndefined();

  const baseUrl = new URL(test.info().project.use.baseURL ?? "");
  await expect(
    quickTunnelHmrUpgrade(Number(baseUrl.port), "hmr-regression.trycloudflare.com"),
  ).resolves.toBe("HTTP/1.1 101 Switching Protocols");
  await expect(
    quickTunnelHmrUpgrade(
      Number(baseUrl.port),
      "hmr-regression.trycloudflare.com",
      "other-route.trycloudflare.com",
    ),
  ).resolves.toBe("Unauthorized");
});

test("a Next.js startup failure occurs before the persistent runtime starts", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "platform-startup-collision-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  try {
    const result = spawnSync("pnpm", ["dev"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: "39999",
        PLATFORM_DATA_DIR: dataDirectory,
        QUICK_TUNNELS_ENABLED: "false",
      },
    });
    expect(result.status).not.toBe(0);
    expect(stripVTControlCharacters(`${result.stdout}\n${result.stderr}`)).toContain(
      "Another next dev server is already running",
    );
    expect(fs.existsSync(dataDirectory)).toBe(false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function quickTunnelHmrUpgrade(
  port: number,
  hostname: string,
  originHostname = hostname,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Quick Tunnel HMR WebSocket upgrade timed out"));
    }, 10_000);
    socket.once("connect", () => {
      socket.write(
        [
          "GET /_next/hmr?id=quick-tunnel-regression HTTP/1.1",
          `Host: ${hostname}`,
          `Origin: https://${originHostname}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", (data) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(data.toString("utf8").split("\r\n", 1)[0] ?? "");
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
