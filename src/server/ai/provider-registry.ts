import crypto from "node:crypto";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AuthenticatedActor } from "../auth.ts";
import { encryptSecret } from "../crypto.ts";
import { getDb, nowIso, setSetting, setting } from "../db.ts";
import { HttpError } from "../errors.ts";
import { probeActionPlanner } from "./model-probe.ts";
import { OpenAiCompatibleProvider, providerForProfile, validateProviderUrl } from "./provider.ts";
import { consumeAiSecretReference, inspectAiSecretReference } from "./secrets.ts";

const modelInputSchema = z
  .object({
    modelId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
  })
  .strict();

export const configureProviderSchema = z
  .object({
    type: z.string().trim().min(1).max(50).optional().default("openai-compatible"),
    name: z.string().trim().min(1).max(100),
    baseUrl: z.string().url().max(2048),
    secretRef: z.string().min(20).nullable().optional().default(null),
    allowPrivateNetwork: z.boolean().optional().default(false),
    timeoutSeconds: z.number().int().min(5).max(300).optional().default(60),
    maxOutputTokens: z.number().int().min(128).max(8192).optional().default(2048),
    models: z.array(modelInputSchema).min(1).max(20),
  })
  .strict();

export type ConfigureProviderInput = z.input<typeof configureProviderSchema>;

interface ProviderRow {
  id: string;
  type: string;
  name: string;
  base_url: string;
  api_key_ciphertext: string | null;
  enabled: number;
  allow_private_network: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  id: string;
  provider_config_id: string;
  model_id: string;
  display_name: string;
  answer_capable: number;
  action_planner_capable: number;
  last_probe_at: string | null;
  probe_version: number | null;
  metadata_json: string;
}

export interface SafeAiProvider {
  id: string;
  type: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  timeoutSeconds: number;
  maxOutputTokens: number;
  createdAt: string;
  updatedAt: string;
  models: SafeAiModelProfile[];
}

export interface SafeAiModelProfile {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  answerCapable: boolean;
  actionPlannerCapable: boolean;
  lastProbeAt: string | null;
  conversationDefault: boolean;
  actionPlannerDefault: boolean;
}

export function listAiProviders(): SafeAiProvider[] {
  const providers = getDb()
    .prepare("SELECT * FROM ai_provider_configs ORDER BY name COLLATE NOCASE, id")
    .all() as ProviderRow[];
  const profiles = getDb()
    .prepare("SELECT * FROM ai_model_profiles ORDER BY display_name COLLATE NOCASE, id")
    .all() as ProfileRow[];
  const conversationDefault = setting("ai_conversation_default_profile_id");
  const plannerDefault = setting("ai_action_planner_default_profile_id");
  return providers.map((provider) => {
    const metadata = parseMetadata(provider.metadata_json);
    return {
      id: provider.id,
      type: provider.type,
      name: provider.name,
      baseUrl: provider.base_url,
      hasApiKey: Boolean(provider.api_key_ciphertext),
      enabled: Boolean(provider.enabled),
      allowPrivateNetwork: Boolean(provider.allow_private_network),
      timeoutSeconds: metadata.timeoutSeconds,
      maxOutputTokens: metadata.maxOutputTokens,
      createdAt: provider.created_at,
      updatedAt: provider.updated_at,
      models: profiles
        .filter((profile) => profile.provider_config_id === provider.id)
        .map((profile) => ({
          id: profile.id,
          providerId: provider.id,
          modelId: profile.model_id,
          displayName: profile.display_name,
          answerCapable: Boolean(profile.answer_capable),
          actionPlannerCapable: Boolean(profile.action_planner_capable),
          lastProbeAt: profile.last_probe_at,
          conversationDefault: profile.id === conversationDefault,
          actionPlannerDefault: profile.id === plannerDefault,
        })),
    };
  });
}

export function inspectProviderSecret(input: {
  actor: AuthenticatedActor;
  secretRef: string;
  baseUrl: string;
}): void {
  inspectAiSecretReference({
    actor: input.actor,
    secretRef: input.secretRef,
    kind: "provider_api_key",
    scope: { type: "ai", id: input.baseUrl },
  });
}

export async function configureAiProvider(
  actor: AuthenticatedActor,
  rawInput: ConfigureProviderInput,
): Promise<SafeAiProvider> {
  const input = configureProviderSchema.parse(rawInput);
  await validateProviderUrl(input.baseUrl, input.allowPrivateNetwork);
  const apiKey = input.secretRef
    ? consumeAiSecretReference({
        actor,
        secretRef: input.secretRef,
        kind: "provider_api_key",
        scope: { type: "ai", id: input.baseUrl },
      })
    : undefined;
  const probe = new OpenAiCompatibleProvider({
    baseUrl: input.baseUrl,
    modelId: input.models[0]?.modelId ?? "",
    apiKey,
    allowPrivateNetwork: input.allowPrivateNetwork,
    timeoutMs: input.timeoutSeconds * 1000,
    maxOutputTokens: Math.min(256, input.maxOutputTokens),
  });
  const result = await probe.complete(
    [{ role: "user", content: "Reply with the single word OK." }],
    [],
  );
  if (!result.content?.trim()) {
    throw new HttpError(
      502,
      "AI provider health probe returned no text",
      "ai_provider_probe_failed",
    );
  }

  const id = crypto.randomUUID();
  const now = nowIso();
  const profileIds = input.models.map(() => crypto.randomUUID());
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO ai_provider_configs(
          id, type, name, base_url, api_key_ciphertext, enabled,
          allow_private_network, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.name,
        input.baseUrl,
        apiKey ? encryptSecret(apiKey) : null,
        input.allowPrivateNetwork ? 1 : 0,
        JSON.stringify({
          timeoutSeconds: input.timeoutSeconds,
          maxOutputTokens: input.maxOutputTokens,
        }),
        now,
        now,
      );
    for (const [index, model] of input.models.entries()) {
      getDb()
        .prepare(
          `INSERT INTO ai_model_profiles(
            id, provider_config_id, model_id, display_name, answer_capable,
            action_planner_capable, metadata_json
          ) VALUES (?, ?, ?, ?, 1, 0, '{}')`,
        )
        .run(profileIds[index], id, model.modelId, model.displayName);
    }
    if (!setting("ai_conversation_default_profile_id") && profileIds[0]) {
      setSetting("ai_conversation_default_profile_id", profileIds[0]);
    }
  })();
  audit({
    userId: actor.id,
    action: "ai.provider.configured",
    entityType: "ai_provider",
    entityId: id,
    details: {
      name: input.name,
      baseUrl: input.baseUrl,
      hasApiKey: Boolean(apiKey),
      models: input.models.map((model) => model.modelId),
    },
  });
  const configured = listAiProviders().find((provider) => provider.id === id);
  if (!configured) throw new Error("Configured AI provider could not be read back");
  return configured;
}

export function removeAiProvider(actor: AuthenticatedActor, providerId: string): void {
  const provider = getProviderRow(providerId);
  const profileIds = getDb()
    .prepare("SELECT id FROM ai_model_profiles WHERE provider_config_id = ?")
    .all(providerId) as Array<{ id: string }>;
  const selected = new Set([
    setting("ai_conversation_default_profile_id"),
    setting("ai_action_planner_default_profile_id"),
  ]);
  if (profileIds.some((profile) => selected.has(profile.id))) {
    throw new HttpError(
      409,
      "Choose replacement default models before removing this provider",
      "ai_provider_in_use",
    );
  }
  getDb().prepare("DELETE FROM ai_provider_configs WHERE id = ?").run(providerId);
  audit({
    userId: actor.id,
    action: "ai.provider.removed",
    entityType: "ai_provider",
    entityId: providerId,
    details: { name: provider.name },
  });
}

export function setAiModelDefault(
  actor: AuthenticatedActor,
  profileId: string,
  purpose: "conversation" | "action_planner",
): SafeAiModelProfile {
  const profile = getModelProfile(profileId);
  if (purpose === "conversation" && !profile.answerCapable) {
    throw new HttpError(409, "Model has not passed the chat probe", "ai_model_not_chat_ready");
  }
  if (purpose === "action_planner" && !profile.actionPlannerCapable) {
    throw new HttpError(
      409,
      "Model has not passed the action-planner probe",
      "ai_model_not_planner_ready",
    );
  }
  setSetting(
    purpose === "conversation"
      ? "ai_conversation_default_profile_id"
      : "ai_action_planner_default_profile_id",
    profileId,
  );
  audit({
    userId: actor.id,
    action: "ai.model.default_changed",
    entityType: "ai_model_profile",
    entityId: profileId,
    details: { purpose },
  });
  return getModelProfile(profileId);
}

export async function probeAiModelProfile(
  actor: AuthenticatedActor,
  profileId: string,
): Promise<Awaited<ReturnType<typeof probeActionPlanner>>> {
  getModelProfile(profileId);
  const result = await probeActionPlanner(providerForProfile(profileId));
  getDb()
    .prepare(
      `UPDATE ai_model_profiles
       SET answer_capable = 1, action_planner_capable = ?, last_probe_at = ?, probe_version = 1
       WHERE id = ?`,
    )
    .run(result.actionPlannerCapable ? 1 : 0, nowIso(), profileId);
  audit({
    userId: actor.id,
    action: "ai.model.probed",
    entityType: "ai_model_profile",
    entityId: profileId,
    details: { actionPlannerCapable: result.actionPlannerCapable },
  });
  return result;
}

export function getModelProfile(profileId: string): SafeAiModelProfile {
  for (const provider of listAiProviders()) {
    const profile = provider.models.find((candidate) => candidate.id === profileId);
    if (profile) return profile;
  }
  throw new HttpError(404, "AI model profile not found", "ai_model_not_found");
}

function getProviderRow(providerId: string): ProviderRow {
  const row = getDb().prepare("SELECT * FROM ai_provider_configs WHERE id = ?").get(providerId) as
    | ProviderRow
    | undefined;
  if (!row) throw new HttpError(404, "AI provider not found", "ai_provider_not_found");
  return row;
}

function parseMetadata(value: string): { timeoutSeconds: number; maxOutputTokens: number } {
  try {
    const parsed = z
      .object({
        timeoutSeconds: z.number().int().min(5).max(300).default(60),
        maxOutputTokens: z.number().int().min(128).max(8192).default(2048),
      })
      .passthrough()
      .parse(JSON.parse(value));
    return parsed;
  } catch {
    return { timeoutSeconds: 60, maxOutputTokens: 2048 };
  }
}
