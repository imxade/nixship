import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneLogs } from "../../src/server/log-retention.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("log retention", () => {
  it("deletes expired inactive logs but preserves current logs", () => {
    const root = temporaryRoot();
    const activeId = "11111111-1111-4111-8111-111111111111";
    const inactiveId = "22222222-2222-4222-8222-222222222222";
    const active = write(root, `${activeId}.stdout.log`, 10);
    const inactive = write(root, `${inactiveId}.stdout.log`, 10);
    fs.utimesSync(active, new Date(0), new Date(0));
    fs.utimesSync(inactive, new Date(0), new Date(0));

    const result = pruneLogs(root, new Set([activeId]), { maxAgeMs: 1000, maxBytes: 100 }, 10_000);

    expect(result).toEqual({ removed: 1, truncated: 0, totalBytes: 10 });
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(inactive)).toBe(false);
  });

  it("bounds disk use even when only an active append target remains", () => {
    const root = temporaryRoot();
    const activeId = "33333333-3333-4333-8333-333333333333";
    const active = write(root, `${activeId}.stderr.log`, 128);

    const result = pruneLogs(root, new Set([activeId]), { maxAgeMs: 1000, maxBytes: 64 });

    expect(result).toEqual({ removed: 0, truncated: 1, totalBytes: 0 });
    expect(fs.statSync(active).size).toBe(0);
    fs.appendFileSync(active, "still connected");
    expect(fs.readFileSync(active, "utf8")).toBe("still connected");
  });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-logs-"));
  roots.push(root);
  return root;
}

function write(root: string, name: string, bytes: number): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, "x"));
  return file;
}
