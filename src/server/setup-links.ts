import fs from "node:fs";
import { isSetupComplete } from "./auth.ts";
import { paths } from "./paths.ts";

const MAX_SETUP_TOKEN_BYTES = 512;

export function firstRunSetupUrl(baseUrl: string, token: string): string {
  const url = new URL("/api/setup/claim", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function currentSetupToken(): string | null {
  if (isSetupComplete()) return null;
  let descriptor: number | null = null;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(paths.setupTokenFile, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SETUP_TOKEN_BYTES) return null;
    const token = fs.readFileSync(descriptor, "utf8").trim();
    return /^[a-zA-Z0-9_-]{16,256}$/.test(token) ? token : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function resolveStartupBanner(options: {
  quickTunnelUrl: string | null;
  lanUrl: string;
  setupToken: string | null;
}): { label: string; url: string } {
  const baseUrl = options.quickTunnelUrl ?? options.lanUrl;
  const label = options.quickTunnelUrl ? "QUICK TUNNEL" : "LAN";
  const url = options.setupToken ? firstRunSetupUrl(baseUrl, options.setupToken) : baseUrl;
  return { label, url };
}
