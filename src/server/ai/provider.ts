import dns from "node:dns/promises";
import { isIP } from "node:net";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, type ModelMessage, type ToolSet, tool } from "ai";
import { config } from "../config.ts";
import { decryptSecret } from "../crypto.ts";
import { getDb, setting } from "../db.ts";
import { HttpError } from "../errors.ts";

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderResponse {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
}

export interface AiProvider {
  id: string;
  modelId: string;
  plannerProbeBypass?: boolean;
  complete(messages: ProviderMessage[], tools: ProviderTool[]): Promise<ProviderResponse>;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = "openai-compatible";

  constructor(
    private readonly options: {
      baseUrl: string;
      modelId: string;
      apiKey?: string;
      allowPrivateNetwork?: boolean;
      timeoutMs?: number;
      maxOutputTokens?: number;
      disableReasoning?: boolean;
      fetchImplementation?: typeof fetch;
    },
  ) {}

  get modelId(): string {
    return this.options.modelId;
  }

  async complete(messages: ProviderMessage[], tools: ProviderTool[]): Promise<ProviderResponse> {
    const baseUrl = await validateProviderUrl(
      this.options.baseUrl,
      this.options.allowPrivateNetwork ?? false,
    );
    const sdkProvider = createOpenAICompatible({
      name: "nix-ship-openai-compatible",
      baseURL: baseUrl.toString().replace(/\/$/, ""),
      apiKey: this.options.apiKey,
      fetch: secureProviderFetch(this.options.fetchImplementation ?? fetch),
      transformRequestBody: (body) => ({
        ...body,
        ...(this.options.disableReasoning ? { think: false } : {}),
      }),
    });
    try {
      const result = await generateText({
        model: sdkProvider(this.options.modelId),
        messages: toModelMessages(messages),
        allowSystemInMessages: true,
        tools: toSdkTools(tools),
        temperature: 0,
        maxOutputTokens: this.options.maxOutputTokens ?? 768,
        maxRetries: 0,
        timeout: this.options.timeoutMs ?? 60_000,
      });
      return {
        content: result.text || null,
        toolCalls: result.toolCalls.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          arguments: normalizeToolInput(call.input),
        })),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (isInvalidToolInput(error)) {
        throw new HttpError(
          502,
          "AI provider returned invalid tool arguments",
          "invalid_tool_input",
        );
      }
      if (isTimeoutError(error)) {
        throw new HttpError(504, "AI provider request timed out", "ai_provider_timeout");
      }
      throw new HttpError(502, "AI provider is unavailable", "ai_provider_unavailable");
    }
  }
}

function secureProviderFetch(fetchImplementation: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImplementation(input, { ...init, redirect: "error" });
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > 1024 * 1024) {
      throw new HttpError(502, "AI provider response is too large", "ai_response_too_large");
    }
    return response;
  };
}

function toSdkTools(tools: ProviderTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((entry) => [
      entry.name,
      tool({
        description: entry.description,
        inputSchema: jsonSchema(entry.parameters),
        outputSchema: jsonSchema({}),
      }),
    ]),
  );
}

function toModelMessages(messages: ProviderMessage[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((message): ModelMessage => {
    if (message.role === "system" || message.role === "user") {
      return { role: message.role, content: message.content };
    }
    if (message.role === "assistant") {
      const calls = message.tool_calls ?? [];
      for (const call of calls) toolNames.set(call.id, call.function.name);
      if (calls.length === 0) return { role: "assistant", content: message.content };
      return {
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...calls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.function.name,
            input: parseToolArguments(call.function.arguments),
          })),
        ],
      };
    }
    const toolCallId = message.tool_call_id;
    if (!toolCallId) {
      throw new HttpError(500, "Tool result is missing its call ID", "invalid_tool_message");
    }
    const toolName = toolNames.get(toolCallId);
    if (!toolName) {
      throw new HttpError(500, "Tool result has no matching tool call", "invalid_tool_message");
    }
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "text", value: message.content },
        },
      ],
    };
  });
}

function isInvalidToolInput(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return /tool.*(input|call)|validation/i.test(name);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /timeout|timed out/i.test(`${error.name} ${error.message}`);
}

interface StoredProviderProfileRow {
  profile_id: string;
  provider_id: string;
  base_url: string;
  api_key_ciphertext: string | null;
  allow_private_network: number;
  metadata_json: string;
  model_id: string;
}

export function configuredAiProvider(profileId?: string | null): AiProvider {
  const stored = selectedStoredProfile(profileId);
  if (stored) return providerFromStoredProfile(stored);
  if (!config.PLATFORM_AI_BASE_URL || !config.PLATFORM_AI_MODEL) {
    throw new HttpError(
      503,
      "Configure PLATFORM_AI_BASE_URL and PLATFORM_AI_MODEL to enable the assistant.",
      "ai_not_configured",
    );
  }
  return new OpenAiCompatibleProvider({
    baseUrl: config.PLATFORM_AI_BASE_URL,
    modelId: config.PLATFORM_AI_MODEL,
    apiKey: config.PLATFORM_AI_API_KEY,
    allowPrivateNetwork: config.PLATFORM_AI_ALLOW_PRIVATE_NETWORK,
    timeoutMs: config.PLATFORM_AI_TIMEOUT_SECONDS * 1000,
    disableReasoning: isOllamaUrl(config.PLATFORM_AI_BASE_URL),
  });
}

export function providerForProfile(profileId: string): AiProvider {
  const stored = selectedStoredProfile(profileId, true);
  if (!stored) throw new HttpError(404, "AI model profile not found", "ai_model_not_found");
  return providerFromStoredProfile(stored);
}

function isOllamaUrl(value: string): boolean {
  const url = new URL(value);
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && url.port === "11434";
}

export function aiProviderStatus(): {
  configured: boolean;
  provider: string | null;
  model: string | null;
  remote: boolean;
} {
  const stored = selectedStoredProfile();
  if (stored) {
    return {
      configured: true,
      provider: stored.provider_id,
      model: stored.model_id,
      remote: !isPrivateHostname(new URL(stored.base_url).hostname),
    };
  }
  if (!config.PLATFORM_AI_BASE_URL || !config.PLATFORM_AI_MODEL) {
    return { configured: false, provider: null, model: null, remote: false };
  }
  const hostname = new URL(config.PLATFORM_AI_BASE_URL).hostname;
  return {
    configured: true,
    provider: "OpenAI-compatible",
    model: config.PLATFORM_AI_MODEL,
    remote: !isPrivateHostname(hostname),
  };
}

export async function validateProviderUrl(
  value: string,
  allowPrivateNetwork: boolean,
): Promise<URL> {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new HttpError(
      400,
      "AI provider URL cannot contain credentials, query, or fragment",
      "invalid_ai_url",
    );
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new HttpError(400, "AI provider URL must use HTTPS", "invalid_ai_url");
  }
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : (await dns.lookup(url.hostname, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isLinkLocalOrMetadata)) {
    throw new HttpError(400, "AI provider address is not allowed", "blocked_ai_address");
  }
  const hasPrivateAddress = addresses.some(isPrivateAddress);
  if (hasPrivateAddress && !allowPrivateNetwork) {
    throw new HttpError(
      400,
      "Private-network AI endpoints require explicit enablement",
      "private_ai_disabled",
    );
  }
  if (url.protocol === "http:" && (!allowPrivateNetwork || !hasPrivateAddress)) {
    throw new HttpError(400, "Unencrypted public AI endpoints are not allowed", "invalid_ai_url");
  }
  return url;
}

function selectedStoredProfile(
  explicitProfileId?: string | null,
  explicitOnly = false,
): StoredProviderProfileRow | null {
  const profileId =
    explicitProfileId ||
    (explicitOnly ? null : setting("ai_conversation_default_profile_id")) ||
    (explicitOnly ? null : setting("ai_action_planner_default_profile_id"));
  if (!profileId) return null;
  return (getDb()
    .prepare(
      `SELECT
         p.id AS profile_id,
         c.id AS provider_id,
         c.base_url,
         c.api_key_ciphertext,
         c.allow_private_network,
         c.metadata_json,
         p.model_id
       FROM ai_model_profiles p
       JOIN ai_provider_configs c ON c.id = p.provider_config_id
       WHERE p.id = ? AND c.enabled = 1`,
    )
    .get(profileId) ?? null) as StoredProviderProfileRow | null;
}

function providerFromStoredProfile(row: StoredProviderProfileRow): AiProvider {
  let metadata: { timeoutSeconds?: number; maxOutputTokens?: number } = {};
  try {
    metadata = JSON.parse(row.metadata_json) as typeof metadata;
  } catch {}
  const provider = new OpenAiCompatibleProvider({
    baseUrl: row.base_url,
    modelId: row.model_id,
    apiKey: row.api_key_ciphertext ? decryptSecret(row.api_key_ciphertext) : undefined,
    allowPrivateNetwork: Boolean(row.allow_private_network),
    timeoutMs: Math.min(300, Math.max(5, metadata.timeoutSeconds ?? 60)) * 1000,
    maxOutputTokens: Math.min(8192, Math.max(128, metadata.maxOutputTokens ?? 768)),
    disableReasoning: isOllamaUrl(row.base_url),
  });
  return {
    id: row.provider_id,
    modelId: provider.modelId,
    complete: (messages, tools) => provider.complete(messages, tools),
  };
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new HttpError(502, "AI provider returned invalid tool arguments", "invalid_tool_input");
  }
}

function normalizeToolInput(value: unknown): unknown {
  if (typeof value === "string") return parseToolArguments(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(502, "AI provider returned invalid tool arguments", "invalid_tool_input");
  }
  return value;
}

function isPrivateHostname(hostname: string): boolean {
  return hostname === "localhost" || isPrivateAddress(hostname);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  ) {
    return true;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isLinkLocalOrMetadata(address: string): boolean {
  return (
    address === "169.254.169.254" ||
    address.startsWith("169.254.") ||
    address.toLowerCase().startsWith("fe80:")
  );
}
