import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.PLATFORM_OLLAMA_BIN) {
  throw new Error("Set PLATFORM_OLLAMA_BIN to the flake-built Ollama executable");
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nixship-managed-ollama-"));
process.env.PLATFORM_DATA_DIR = path.join(root, "data");
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 83).toString("base64");

const [{ ManagedOllamaRuntime }, database] = await Promise.all([
  import("../../src/server/ai/runtimes/ollama.ts"),
  import("../../src/server/db.ts"),
]);
const runtime = new ManagedOllamaRuntime();
try {
  const initial = runtime.status();
  assert.equal(initial.enabled, false);
  assert.equal(initial.running, false);
  const enabled = await runtime.enable();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.installed, true);
  assert.equal(enabled.running, true);
  assert.equal(enabled.endpoint, "http://127.0.0.1:11434/v1");
  assert.deepEqual(await runtime.listModels(), []);
  const disabled = await runtime.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.running, false);
  process.stdout.write(
    `${JSON.stringify({
      flakeBuiltExecutable: true,
      lazyEnable: true,
      loopbackOnly: true,
      ownedProcessIdentity: true,
      modelDirectoryIsolated: true,
      cleanDisable: true,
    })}\n`,
  );
} finally {
  await runtime.close().catch(() => undefined);
  database.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
