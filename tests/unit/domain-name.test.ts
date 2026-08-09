import { describe, expect, it } from "vitest";
import { registrableDomain } from "../../src/server/domain-name.ts";

describe("registrable domain discovery", () => {
  it.each([
    ["example.com", "example.com"],
    ["api.example.com", "example.com"],
    ["deep.api.example.co.uk", "example.co.uk"],
    ["app.github.io", "app.github.io"],
  ])("derives the apex for %s", (hostname, expected) => {
    expect(registrableDomain(hostname)).toBe(expected);
  });

  it("rejects a public suffix without a registrable label", () => {
    expect(() => registrableDomain("com")).toThrowError(
      expect.objectContaining({ code: "domain_apex_unknown" }),
    );
  });
});
