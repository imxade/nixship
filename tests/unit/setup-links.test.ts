import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { logger } from "../../src/server/logger.ts";
import { firstRunSetupUrl } from "../../src/server/setup-links.ts";

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

describe("first-run setup banner", () => {
  it("shows LAN URL when no Quick Tunnel is available", () => {
    const output = captureBanner(() => {
      logger.setupBanner([
        { label: "LAN", url: "http://10.0.0.205:3000/api/setup/claim?token=abc123" },
      ]);
    });
    expect(output).toContain("NIX SHIP FIRST-RUN SETUP");
    expect(output).toContain("│ LAN");
    expect(output).toContain("│ http://10.0.0.205:3000/api/setup/claim?token=abc123");
    expect(output).not.toContain("QUICK TUNNEL");
    expect(output).not.toContain("CLAIM");
  });

  it("shows LAN, Quick Tunnel, and Claim URLs in one banner", () => {
    const token = "first_run_token_xyz";
    const lanUrl = firstRunSetupUrl("http://10.0.0.205:3000", token);
    const tunnelBase = "https://possible-beyond-clip-ruling.trycloudflare.com";
    const claimUrl = firstRunSetupUrl(tunnelBase, token);
    const output = captureBanner(() => {
      logger.setupBanner([
        { label: "LAN", url: lanUrl },
        { label: "QUICK TUNNEL", url: tunnelBase },
        { label: "CLAIM", url: claimUrl },
      ]);
    });
    expect(output).toContain("NIX SHIP FIRST-RUN SETUP");
    expect(output).toContain("│ LAN");
    expect(output).toContain(`│ ${lanUrl}`);
    expect(output).toContain("│ QUICK TUNNEL");
    expect(output).toContain(`│ ${tunnelBase}`);
    expect(output).toContain("│ CLAIM");
    expect(output).toContain(`│ ${claimUrl}`);
  });

  it("Quick Tunnel claim URL reuses the same first-run token", () => {
    const token = "shared_token_42";
    const lanClaim = firstRunSetupUrl("http://192.168.1.5:3000", token);
    const tunnelClaim = firstRunSetupUrl(
      "https://example-tunnel.trycloudflare.com",
      token,
    );
    expect(lanClaim).toContain(`token=${token}`);
    expect(tunnelClaim).toContain(`token=${token}`);
    expect(tunnelClaim).toBe(
      `https://example-tunnel.trycloudflare.com/api/setup/claim?token=${token}`,
    );
  });
});

function captureBanner(fn: () => void): string {
  const original = console.log;
  let captured = "";
  console.log = (message: string) => {
    captured += message;
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return captured;
}
