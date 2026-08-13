import { describe, expect, it } from "vitest";
import { extractReportedHash, replacePnpmDepsHash } from "../../scripts/refresh-pnpm-deps-hash.ts";

describe("refresh-pnpm-deps-hash", () => {
  it("replaces the single pinned dependency hash", () => {
    const source = `let
  pnpmDeps = pkgs.fetchPnpmDeps {
    hash = "sha256-old=";
  };
in pnpmDeps
`;

    expect(replacePnpmDepsHash(source, "pkgs.lib.fakeHash")).toContain(
      "    hash = pkgs.lib.fakeHash;",
    );
  });

  it("rejects an ambiguous Nix expression", () => {
    const source = `hash = "sha256-first=";\nhash = "sha256-second=";\n`;
    expect(() => replacePnpmDepsHash(source, "pkgs.lib.fakeHash")).toThrow(
      "Expected exactly one fetchPnpmDeps hash assignment, found 2",
    );
  });

  it("extracts the hash reported by a failed fixed-output build", () => {
    const output = `
error: hash mismatch in fixed-output derivation
         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
            got:    sha256-VbR/XGXpeA0jh+BeJcBm2SG4uhxojXkmK0FlXSDygpE=
`;

    expect(extractReportedHash(output)).toBe("sha256-VbR/XGXpeA0jh+BeJcBm2SG4uhxojXkmK0FlXSDygpE=");
  });

  it("rejects output without one unambiguous reported hash", () => {
    expect(() => extractReportedHash("build failed before reporting a hash")).toThrow(
      "Expected exactly one Nix reported dependency hash, found 0",
    );
  });
});
