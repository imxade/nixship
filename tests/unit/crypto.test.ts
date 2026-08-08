import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  sha256,
  verifyPassword,
} from "../../src/server/crypto.ts";

process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 43).toString("base64");

describe("credential primitives", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });
  it("creates stable digests", () => expect(sha256("platform")).toHaveLength(64));

  it("round-trips empty encrypted values", () => {
    const encrypted = encryptSecret("");
    expect(encrypted.split(".")).toHaveLength(4);
    expect(decryptSecret(encrypted)).toBe("");
  });
});
