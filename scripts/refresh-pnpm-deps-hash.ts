import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HASH_ASSIGNMENT = /^(\s*)hash = "sha256-[A-Za-z0-9+/=]+";$/gm;
const REPORTED_HASH = /^\s*got:\s+(sha256-[A-Za-z0-9+/=]+)\s*$/gm;

export function replacePnpmDepsHash(source: string, value: string): string {
  const matches = [...source.matchAll(HASH_ASSIGNMENT)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one fetchPnpmDeps hash assignment, found ${matches.length}`);
  }

  return source.replace(HASH_ASSIGNMENT, `$1hash = ${value};`);
}

export function extractReportedHash(output: string): string {
  const hashes = new Set([...output.matchAll(REPORTED_HASH)].map((match) => match[1]));
  if (hashes.size !== 1) {
    throw new Error(`Expected exactly one Nix reported dependency hash, found ${hashes.size}`);
  }

  const [hash] = hashes;
  if (!hash) throw new Error("Nix did not report a dependency hash");
  return hash;
}

export function refreshPnpmDepsHash(root = process.cwd()): string {
  const nixFile = path.join(root, "nixship.nix");
  const original = fs.readFileSync(nixFile, "utf8");
  const fakeHashSource = replacePnpmDepsHash(original, "pkgs.lib.fakeHash");
  let updated = false;

  try {
    fs.writeFileSync(nixFile, fakeHashSource);
    const result = spawnSync("nix", ["build", "--no-link", "--print-build-logs", ".#default"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

    if (result.error) throw result.error;
    if (result.status === 0) {
      throw new Error("Nix unexpectedly accepted pkgs.lib.fakeHash");
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const hash = extractReportedHash(output);
    fs.writeFileSync(nixFile, replacePnpmDepsHash(original, `"${hash}"`));
    updated = true;
    return hash;
  } finally {
    if (!updated) fs.writeFileSync(nixFile, original);
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  const hash = refreshPnpmDepsHash();
  console.log(`Updated nixship.nix fetchPnpmDeps hash to ${hash}`);
}
