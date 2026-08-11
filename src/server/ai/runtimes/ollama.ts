import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runCommand, spawnLogged } from "../../command.ts";
import { config } from "../../config.ts";
import { getDb, setSetting, setting } from "../../db.ts";
import { errorMessage, HttpError } from "../../errors.ts";
import { logger } from "../../logger.ts";
import { paths } from "../../paths.ts";
import {
  captureProcessIdentity,
  matchesProcessIdentity,
  type ProcessIdentity,
} from "../../process-identity.ts";

const OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,100})?$/;
const ollamaTagsSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().min(1).max(301),
            size: z.number().finite().nonnegative(),
            digest: z.string().min(1).max(256),
            modified_at: z.string().min(1).max(128),
            details: z
              .object({
                parameter_size: z.string().max(64).optional(),
                quantization_level: z.string().max(64).optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export interface LocalOllamaModel {
  name: string;
  sizeBytes: number;
  digest: string;
  modifiedAt: string;
  parameterSize: string | null;
  quantization: string | null;
}

export interface OllamaPullProgress {
  status: string;
  digest: string | null;
  completedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
}

const ollamaPullProgressSchema = z
  .object({
    status: z.string().min(1).max(500),
    digest: z.string().max(256).optional(),
    completed: z.number().finite().nonnegative().optional(),
    total: z.number().finite().nonnegative().optional(),
    error: z.string().max(2000).optional(),
  })
  .passthrough();

export class ManagedOllamaRuntime {
  private identity: ProcessIdentity | null = null;

  async boot(): Promise<void> {
    if (setting("ai_ollama_enabled") === "1") {
      await this.start().catch((error) =>
        logger.error("Managed Ollama recovery failed", { error: errorMessage(error) }),
      );
    }
  }

  async close(): Promise<void> {
    await this.stopProcess();
  }

  status(): {
    managed: true;
    enabled: boolean;
    installed: boolean;
    running: boolean;
    endpoint: string;
    modelsDirectory: string;
    nixReference: string | null;
    lastError: string | null;
  } {
    const executable = config.PLATFORM_OLLAMA_BIN || setting("ai_ollama_executable");
    return {
      managed: true,
      enabled: setting("ai_ollama_enabled") === "1",
      installed: Boolean(executable && fs.existsSync(executable)),
      running: this.isRunning(),
      endpoint: `${OLLAMA_ENDPOINT}/v1`,
      modelsDirectory: modelDirectory(),
      nixReference: config.PLATFORM_OLLAMA_NIX_REF || null,
      lastError: setting("ai_ollama_last_error") ?? null,
    };
  }

  resourcePreflight(): {
    supported: boolean;
    totalMemoryBytes: number;
    freeDiskBytes: number;
    warnings: string[];
  } {
    const warnings: string[] = [];
    const android = Boolean(process.env.ANDROID_ROOT || process.env.TERMUX_VERSION);
    const supportedPlatform = ["linux", "darwin"].includes(process.platform);
    const supportedArchitecture = ["x64", "arm64"].includes(process.arch);
    const totalMemoryBytes = os.totalmem();
    const stats = fs.statfsSync(paths.data);
    const freeDiskBytes = Number(stats.bavail) * Number(stats.bsize);
    if (android) warnings.push("Managed Ollama is not supported on Android/Nix-on-Droid.");
    if (totalMemoryBytes < 4 * 1024 ** 3)
      warnings.push("Less than 4 GiB RAM is available; use remote inference instead.");
    if (freeDiskBytes < 5 * 1024 ** 3)
      warnings.push("Less than 5 GiB disk is free; model downloads may be refused.");
    return {
      supported: !android && supportedPlatform && supportedArchitecture,
      totalMemoryBytes,
      freeDiskBytes,
      warnings,
    };
  }

  async enable(): Promise<ReturnType<ManagedOllamaRuntime["status"]>> {
    if (!this.resourcePreflight().supported) {
      throw new HttpError(
        409,
        "Managed Ollama is unsupported on this host; configure a remote provider instead",
        "ollama_unsupported",
      );
    }
    setSetting("ai_ollama_enabled", "1");
    try {
      await this.start();
      getDb().prepare("DELETE FROM settings WHERE key = 'ai_ollama_last_error'").run();
    } catch (error) {
      setSetting("ai_ollama_last_error", errorMessage(error).slice(0, 1000));
      throw error;
    }
    return this.status();
  }

  async disable(): Promise<ReturnType<ManagedOllamaRuntime["status"]>> {
    setSetting("ai_ollama_enabled", "0");
    await this.stopProcess();
    return this.status();
  }

  async listModels(): Promise<LocalOllamaModel[]> {
    if (!this.isRunning()) return [];
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new HttpError(502, "Ollama model listing failed", "ollama_error");
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) {
      throw new HttpError(502, "Ollama response is too large", "ollama_response_too_large");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(502, "Ollama returned invalid JSON", "ollama_invalid_response");
    }
    const parsed = ollamaTagsSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new HttpError(502, "Ollama returned an invalid model list", "ollama_invalid_response");
    }
    return parsed.data.models.map((model) => ({
      name: model.name,
      sizeBytes: model.size,
      digest: model.digest,
      modifiedAt: model.modified_at,
      parameterSize: model.details?.parameter_size ?? null,
      quantization: model.details?.quantization_level ?? null,
    }));
  }

  async pullModel(
    model: string,
    onProgress?: (progress: OllamaPullProgress) => void,
  ): Promise<LocalOllamaModel> {
    validateModelId(model);
    await this.start();
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      redirect: "error",
      signal: AbortSignal.timeout(2 * 60 * 60_000),
    });
    if (!response.ok || !response.body) {
      throw new HttpError(502, "Ollama model download failed", "ollama_pull_failed");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let receivedBytes = 0;
    const parseLine = (line: string): void => {
      if (!line.trim()) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(line) as unknown;
      } catch {
        throw new HttpError(
          502,
          "Ollama returned invalid download progress",
          "ollama_invalid_response",
        );
      }
      const progress = ollamaPullProgressSchema.safeParse(decoded);
      if (!progress.success) {
        throw new HttpError(
          502,
          "Ollama returned invalid download progress",
          "ollama_invalid_response",
        );
      }
      if (progress.data.error) {
        throw new HttpError(502, "Ollama model download failed", "ollama_pull_failed");
      }
      const total = progress.data.total ?? null;
      const completed = progress.data.completed ?? null;
      onProgress?.({
        status: progress.data.status,
        digest: progress.data.digest ?? null,
        completedBytes: completed,
        totalBytes: total,
        percent:
          completed !== null && total !== null && total > 0
            ? Math.min(100, Math.round((completed / total) * 1000) / 10)
            : null,
      });
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new HttpError(
          502,
          "Ollama download progress was too large",
          "ollama_response_too_large",
        );
      }
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 64 * 1024 && !pending.includes("\n")) {
        await reader.cancel();
        throw new HttpError(
          502,
          "Ollama returned an oversized progress event",
          "ollama_response_too_large",
        );
      }
      let boundary = pending.indexOf("\n");
      while (boundary >= 0) {
        parseLine(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
        boundary = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    parseLine(pending);
    const installed = (await this.listModels()).find(
      (entry) => entry.name === model || entry.name === `${model}:latest`,
    );
    if (!installed)
      throw new HttpError(500, "Downloaded model was not found", "ollama_verify_failed");
    return installed;
  }

  async removeModel(model: string): Promise<void> {
    validateModelId(model);
    await this.start();
    const result = await runCommand(await this.executable(), ["rm", model], {
      cwd: paths.data,
      env: ollamaEnvironment(),
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 64 * 1024,
    });
    if (result.code !== 0) {
      throw new HttpError(502, "Ollama model removal failed", "ollama_remove_failed");
    }
  }

  private async start(): Promise<void> {
    if (this.isRunning()) return;
    if (await endpointIsReady()) {
      throw new HttpError(
        409,
        "Port 11434 is already served by an Ollama process that Nix Ship does not own",
        "ollama_endpoint_in_use",
      );
    }
    fs.mkdirSync(modelDirectory(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(paths.data, "ai", "ollama"), { recursive: true, mode: 0o700 });
    const executable = await this.executable();
    const log = path.join(paths.logs, "ollama.log");
    const child = spawnLogged(executable, ["serve"], {
      cwd: paths.data,
      env: ollamaEnvironment(),
      stdoutPath: log,
      stderrPath: log,
      detached: true,
    });
    if (!child.pid) throw new Error("Ollama did not return a process ID");
    const identity = captureProcessIdentity(child.pid);
    if (!identity) {
      terminateProcessGroup(child.pid);
      throw new Error("Unable to establish a safe Ollama process identity");
    }
    this.identity = identity;
    setSetting("ai_ollama_process_identity", JSON.stringify(identity));
    child.unref();
    try {
      await waitUntilReady();
    } catch (error) {
      await this.stopProcess();
      throw error;
    }
  }

  private async executable(): Promise<string> {
    const configured = config.PLATFORM_OLLAMA_BIN;
    if (configured) return configured;
    const existing = setting("ai_ollama_executable");
    if (existing && fs.existsSync(existing)) return existing;
    if (!config.PLATFORM_OLLAMA_NIX_REF) {
      throw new HttpError(
        503,
        "This build does not provide a pinned Ollama Nix reference",
        "ollama_not_available",
      );
    }
    const result = await runCommand(
      "nix",
      [
        "build",
        "--out-link",
        path.join(paths.data, "ai", "ollama", "runtime"),
        "--print-out-paths",
        config.PLATFORM_OLLAMA_NIX_REF,
      ],
      { cwd: paths.data, timeoutMs: 30 * 60_000, maxOutputBytes: 128 * 1024 },
    );
    if (result.code !== 0) {
      throw new HttpError(502, "Nix could not install managed Ollama", "ollama_install_failed");
    }
    const storePath = result.stdout.trim().split(/\s+/).at(-1);
    if (!storePath?.startsWith("/nix/store/")) {
      throw new HttpError(502, "Nix returned an invalid Ollama path", "ollama_install_failed");
    }
    const executable = path.join(storePath, "bin", "ollama");
    if (!fs.existsSync(executable)) {
      throw new HttpError(502, "Managed Ollama executable is missing", "ollama_install_failed");
    }
    setSetting("ai_ollama_executable", executable);
    return executable;
  }

  private isRunning(): boolean {
    const identity = this.identity ?? storedIdentity();
    if (identity && matchesProcessIdentity(toStored(identity))) {
      this.identity = identity;
      return true;
    }
    this.identity = null;
    getDb().prepare("DELETE FROM settings WHERE key = 'ai_ollama_process_identity'").run();
    return false;
  }

  private async stopProcess(): Promise<void> {
    const identity = this.identity ?? storedIdentity();
    if (identity && matchesProcessIdentity(toStored(identity))) {
      try {
        process.kill(
          process.platform === "win32" ? identity.pid : -identity.processGroupId,
          "SIGTERM",
        );
      } catch {}
    }
    this.identity = null;
    getDb().prepare("DELETE FROM settings WHERE key = 'ai_ollama_process_identity'").run();
  }
}

function modelDirectory(): string {
  return path.join(paths.data, "ai", "ollama", "models");
}

function ollamaEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OLLAMA_HOST: "127.0.0.1:11434",
    OLLAMA_MODELS: modelDirectory(),
    OLLAMA_ORIGINS: "http://127.0.0.1,http://localhost",
    OLLAMA_MAX_LOADED_MODELS: "1",
    OLLAMA_NUM_PARALLEL: "1",
    OLLAMA_MAX_QUEUE: "8",
  };
}

function validateModelId(model: string): void {
  if (!MODEL_ID.test(model))
    throw new HttpError(400, "Invalid Ollama model ID", "invalid_model_id");
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${OLLAMA_ENDPOINT}/api/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new HttpError(504, "Managed Ollama did not become ready", "ollama_start_timeout");
}

async function endpointIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/version`, {
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function terminateProcessGroup(pid: number): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {}
}

function storedIdentity(): ProcessIdentity | null {
  const raw = setting("ai_ollama_process_identity");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProcessIdentity;
    return parsed.pid > 1 && parsed.processGroupId > 1 ? parsed : null;
  } catch {
    return null;
  }
}

function toStored(identity: ProcessIdentity) {
  return {
    pid: identity.pid,
    process_group_id: identity.processGroupId,
    process_start_ticks: identity.startTicks,
    process_command_hash: identity.commandHash,
    process_command_summary: identity.commandSummary,
  };
}
