import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { firstRunSetupUrl, resolveStartupBanner } from "../../src/server/setup-links.ts";

describe("first-run setup links", () => {
  it("places the one-time credential only in the claim URL", () => {
    expect(firstRunSetupUrl("http://192.168.1.15:3000", "one_time-token_1234")).toBe(
      "http://192.168.1.15:3000/api/setup/claim?token=one_time-token_1234",
    );
  });

  it("replaces any path or query from a Quick Tunnel origin", () => {
    expect(
      firstRunSetupUrl(
        "https://temporary.trycloudflare.com/ignored?value=1",
        "one_time-token_1234",
      ),
    ).toBe("https://temporary.trycloudflare.com/api/setup/claim?token=one_time-token_1234");
  });

  it("drives Android first-run setup through the complete claim URL", () => {
    const flow = fs.readFileSync(
      new URL("../../.maestro/flows/first-run-setup.yaml", import.meta.url),
      "utf8",
    );
    const runner = fs.readFileSync(
      new URL("../../scripts/android/run-maestro.sh", import.meta.url),
      "utf8",
    );
    const setupUrlPlaceholder = "$" + "{SETUP_URL}";
    expect(flow).toContain(`- openLink: ${setupUrlPlaceholder}`);
    expect(`${flow}\n${runner}`).not.toContain("SETUP_TOKEN");
    expect(flow).not.toContain('tapOn: "Setup token"');
  });
});

describe("startup banner resolution", () => {
  const tunnelUrl = "https://test-tunnel.trycloudflare.com";
  const lanUrl = "http://192.168.1.15:3000";
  const token = "one_time-token_1234";

  it("prefers Quick Tunnel with claim URL on first run", () => {
    const result = resolveStartupBanner({ quickTunnelUrl: tunnelUrl, lanUrl, setupToken: token });
    expect(result.label).toBe("QUICK TUNNEL");
    expect(result.url).toBe(
      "https://test-tunnel.trycloudflare.com/api/setup/claim?token=one_time-token_1234",
    );
  });

  it("falls back to LAN with claim URL on first run", () => {
    const result = resolveStartupBanner({ quickTunnelUrl: null, lanUrl, setupToken: token });
    expect(result.label).toBe("LAN");
    expect(result.url).toBe("http://192.168.1.15:3000/api/setup/claim?token=one_time-token_1234");
  });

  it("shows Quick Tunnel base URL on subsequent run", () => {
    const result = resolveStartupBanner({ quickTunnelUrl: tunnelUrl, lanUrl, setupToken: null });
    expect(result.label).toBe("QUICK TUNNEL");
    expect(result.url).toBe("https://test-tunnel.trycloudflare.com");
  });

  it("shows LAN base URL on subsequent run", () => {
    const result = resolveStartupBanner({ quickTunnelUrl: null, lanUrl, setupToken: null });
    expect(result.label).toBe("LAN");
    expect(result.url).toBe("http://192.168.1.15:3000");
  });

  it("never shows both LAN and Quick Tunnel", () => {
    for (const setupToken of [token, null]) {
      const withTunnel = resolveStartupBanner({ quickTunnelUrl: tunnelUrl, lanUrl, setupToken });
      expect(withTunnel.label).toBe("QUICK TUNNEL");
      expect(withTunnel.url).not.toContain("192.168.1.15");

      const withoutTunnel = resolveStartupBanner({ quickTunnelUrl: null, lanUrl, setupToken });
      expect(withoutTunnel.label).toBe("LAN");
      expect(withoutTunnel.url).not.toContain("trycloudflare.com");
    }
  });

  it("includes the claim path only on first run", () => {
    const firstRun = resolveStartupBanner({ quickTunnelUrl: tunnelUrl, lanUrl, setupToken: token });
    expect(firstRun.url).toContain("/api/setup/claim?token=");

    const subsequentRun = resolveStartupBanner({
      quickTunnelUrl: tunnelUrl,
      lanUrl,
      setupToken: null,
    });
    expect(subsequentRun.url).not.toContain("/api/setup/claim");
    expect(subsequentRun.url).not.toContain("token=");
  });

  it("returns exactly one label and one URL", () => {
    const result = resolveStartupBanner({ quickTunnelUrl: tunnelUrl, lanUrl, setupToken: token });
    expect(typeof result.label).toBe("string");
    expect(typeof result.url).toBe("string");
    expect(Object.keys(result)).toEqual(["label", "url"]);
  });
});
