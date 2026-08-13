import { describe, expect, it } from "vitest";
import { normalizeDomain } from "../../src/server/app-service.ts";
import { requestHostname, trustedForwardedProtocol } from "../../src/server/proxy-manager.ts";

describe("custom domains", () => {
  it("normalizes case, a trailing dot, and internationalized names", () => {
    expect(normalizeDomain(" App.Example.COM. ")).toBe("app.example.com");
    expect(normalizeDomain("münich.example")).toBe("xn--mnich-kva.example");
  });

  it.each([
    "localhost",
    "https://app.example.com",
    "app.example.com:443",
    "*.example.com",
    "-bad.example.com",
    "bad-.example.com",
  ])("rejects invalid hostname %s", (hostname) => {
    expect(() => normalizeDomain(hostname)).toThrow();
  });

  it("extracts normalized hostnames from HTTP Host headers", () => {
    expect(requestHostname("App.Example.com:8443")).toBe("app.example.com");
    expect(requestHostname("app.example.com.")).toBe("app.example.com");
    expect(requestHostname("127.0.0.1:3000")).toBeNull();
    expect(requestHostname(undefined)).toBeNull();
  });

  it("preserves HTTPS only from a loopback reverse proxy", () => {
    expect(trustedForwardedProtocol("127.0.0.1", "https", false)).toBe("https");
    expect(trustedForwardedProtocol("192.0.2.40", "https", false)).toBe("http");
    expect(trustedForwardedProtocol("192.0.2.40", undefined, true)).toBe("https");
  });
});
