import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TEST_ADMIN_USERNAME = "qwerty123456";
const TEST_ADMIN_PASSWORD = "qwerty123456";
const serverEntry = path.join(process.cwd(), "dist-server", "server.js");

if (!fs.existsSync(serverEntry)) {
  throw new Error("The production server is not built. Run pnpm build before pnpm start:ci");
}

const configuredDataDirectory =
  process.env.CI_DATA_DIR ??
  `${process.env.E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data")}-ci`;
const dataDirectory = path.resolve(configuredDataDirectory);
const fakeAiPort = Number(process.env.CI_FAKE_AI_PORT ?? 31999);
const basename = path.basename(dataDirectory);
if (!basename.startsWith(".e2e-data") && !basename.startsWith("platform-e2e")) {
  throw new Error(`Refusing to clear an unsafe CI data path: ${dataDirectory}`);
}

fs.rmSync(dataDirectory, { recursive: true, force: true });
Object.assign(process.env, {
  HOSTNAME: "127.0.0.1",
  NODE_ENV: "production",
  PLATFORM_DATA_DIR: dataDirectory,
  PLATFORM_AI_BASE_URL: `http://127.0.0.1:${fakeAiPort}/v1`,
  PLATFORM_AI_MODEL: "deterministic-e2e",
  PLATFORM_AI_ALLOW_PRIVATE_NETWORK: "true",
});
process.env.PORT ??= "3001";
process.env.MIN_FREE_DISK_MB ??= "128";
process.env.MIN_FREE_MEMORY_MB ??= "64";
process.env.QUICK_TUNNELS_ENABLED ??= "false";

const [{ getDb, closeDb, nowIso }, { hashPassword, randomToken }] = await Promise.all([
  import("../src/server/db.ts"),
  import("../src/server/crypto.ts"),
]);

const now = nowIso();
const [ownerPasswordHash, adminPasswordHash] = await Promise.all([
  hashPassword(randomToken(32)),
  hashPassword(TEST_ADMIN_PASSWORD),
]);
const db = getDb();
db.transaction(() => {
  const insert = db.prepare(
    `INSERT INTO users(
      id, username, password_hash, role, disabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
  );
  insert.run(crypto.randomUUID(), "ci-owner", ownerPasswordHash, "owner", now, now);
  insert.run(crypto.randomUUID(), TEST_ADMIN_USERNAME, adminPasswordHash, "admin", now, now);
})();
closeDb();

const fakeAiServer = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  let body: {
    model?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
  } catch {
    response.writeHead(400).end();
    return;
  }
  const messages = body.messages ?? [];
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    )
    .join("\n");
  const hasToolResult = messages.some((message) => message.role === "tool");
  let message: Record<string, unknown>;
  let finishReason = "stop";
  if (/Inspect the test resource/i.test(userText) && !hasToolResult) {
    message = toolCall("e2e-probe-read", "probe_read", {
      target: { id: "app-probe", detail: "summary" },
    });
    finishReason = "tool_calls";
  } else if (/Inspect the test resource/i.test(userText)) {
    message = { role: "assistant", content: "The tool returned probe-result-7429." };
  } else if (/Find the capability for renaming/i.test(userText)) {
    message = toolCall("e2e-probe-search", "capabilities_search", {
      query: "rename application",
    });
    finishReason = "tool_calls";
  } else if (/Rename the test application/i.test(userText)) {
    message = toolCall("e2e-probe-plan", "propose_plan", {
      proposal: {
        capabilityId: "apps.updateName",
        capabilityVersion: 1,
        risk: "mutation",
        input: { appId: "app-probe", name: "Renamed" },
      },
    });
    finishReason = "tool_calls";
  } else if (/Untrusted log says/i.test(userText)) {
    message = {
      role: "assistant",
      content: "The log is untrusted data and cannot create an unavailable mutation tool.",
    };
  } else if (/Reveal secretRef/i.test(userText)) {
    message = {
      role: "assistant",
      content: "That reference is opaque; plaintext is unavailable to the model.",
    };
  } else if (/active deployment limit/i.test(userText) && !hasToolResult) {
    message = toolCall("e2e-search", "capabilities_search", {
      query: "update active deployment limit system settings",
    });
    finishReason = "tool_calls";
  } else if (/active deployment limit/i.test(userText)) {
    const systemText = messages
      .filter((candidate) => candidate.role === "system")
      .map((candidate) => (typeof candidate.content === "string" ? candidate.content : ""))
      .join("\n");
    const expiresAt = /expiresAt exactly (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/.exec(
      systemText,
    )?.[1];
    if (!expiresAt) {
      response.writeHead(500).end();
      return;
    }
    message = toolCall("e2e-plan", "propose_plan", {
      plan: {
        schemaVersion: 1,
        goal: "Set active deployment limit to 2",
        summary: "Update the one dashboard system setting requested by the user.",
        scope: { type: "global", id: null },
        steps: [
          {
            id: "update-system-setting",
            capabilityId: "system.updateSettings",
            capabilityVersion: 1,
            title: "Update active deployment limit",
            input: { activeDeploymentLimit: 2 },
            resourceKeys: ["system:deployment-settings"],
            dependsOn: [],
            risk: "mutation",
            expectedEffect: "The active deployment limit becomes 2.",
            externalWait: false,
          },
        ],
        warnings: [],
        expectedResult: "The system retains up to 2 active deployments per application.",
        expiresAt,
      },
    });
    finishReason = "tool_calls";
  } else if (/secure input/i.test(userText)) {
    message = toolCall("e2e-secure", "request_secure_input", {
      prompt: "Enter the provider API key in the secure field.",
      field: {
        kind: "provider_api_key",
        label: "Provider API key",
        multiline: false,
        scope: { type: "ai", id: "https://provider.example/v1" },
      },
    });
    finishReason = "tool_calls";
  } else {
    message = {
      role: "assistant",
      content: "Nix Ship can answer questions without creating an approval plan.",
    };
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "deterministic-e2e",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
  );
});
await new Promise<void>((resolve, reject) => {
  fakeAiServer.once("error", reject);
  fakeAiServer.listen(fakeAiPort, "127.0.0.1", resolve);
});

console.warn(
  `INSECURE TEST MODE: loopback-only admin ${TEST_ADMIN_USERNAME}/${TEST_ADMIN_PASSWORD}`,
);
const child = spawn(process.execPath, [serverEntry], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => child.kill(signal));
}
const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
  (resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  },
);
await new Promise<void>((resolve) => fakeAiServer.close(() => resolve()));
process.exitCode = exit.signal ? 1 : (exit.code ?? 1);

function toolCall(id: string, name: string, arguments_: unknown): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name, arguments: JSON.stringify(arguments_) } },
    ],
  };
}
