import crypto from "node:crypto";
import fs from "node:fs";
import { logger } from "./logger.ts";
import { paths } from "./paths.ts";

let cachedMasterKey: Buffer | undefined;

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const n = 1 << 15;
  const r = 8;
  const p = 1;
  const length = 64;
  const derived = await deriveScrypt(password, salt, length, {
    N: n,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return ["scrypt", n, r, p, salt.toString("base64"), derived.toString("base64")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || !nText || !rText || !pText || !saltText || !hashText) {
    return false;
  }
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (n !== 1 << 15 || r !== 8 || p !== 1) return false;
  const expected = Buffer.from(hashText, "base64");
  if (expected.length !== 64) return false;
  const actual = await deriveScrypt(password, Buffer.from(saltText, "base64"), expected.length, {
    N: n,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function loadMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const fromEnvironment = process.env.PLATFORM_MASTER_KEY?.trim();
  if (fromEnvironment) {
    const key = Buffer.from(fromEnvironment, "base64");
    if (key.length !== 32)
      throw new Error("PLATFORM_MASTER_KEY must be 32 bytes encoded as base64");
    cachedMasterKey = key;
    return key;
  }
  if (fs.existsSync(paths.keyFile)) {
    const key = Buffer.from(fs.readFileSync(paths.keyFile, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`Invalid master key file: ${paths.keyFile}`);
    cachedMasterKey = key;
    return key;
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(paths.keyFile, generated.toString("base64"), { mode: 0o600, flag: "wx" });
  logger.warn("Generated a local master key; back it up before moving the data directory", {
    path: paths.keyFile,
  });
  cachedMasterKey = generated;
  return generated;
}

export function encryptSecret(plaintext: string): string {
  const key = loadMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(
    ".",
  );
}

export function decryptSecret(encoded: string): string {
  const parts = encoded.split(".");
  const [version, ivText, tagText, cipherText] = parts;
  if (parts.length !== 4 || version !== "v1" || !ivText || !tagText || cipherText === undefined) {
    throw new Error("Unsupported encrypted secret format");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    loadMasterKey(),
    Buffer.from(ivText, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function signJwtRs256(payload: Record<string, unknown>, privateKeyPem: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode(header)}.${encode(payload)}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(body), privateKeyPem)
    .toString("base64url");
  return `${body}.${signature}`;
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  length: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}
