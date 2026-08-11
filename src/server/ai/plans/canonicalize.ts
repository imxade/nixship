import { sha256 } from "../../crypto.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}
