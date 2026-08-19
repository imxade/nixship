import { z } from "zod";
import { audit } from "../audit.ts";
import { setSetting, setting } from "../db.ts";

// ── Planner limits ──────────────────────────────────────────────────────────

const aiMaxModelStepsSchema = z.coerce.number().int().min(2).max(12);
const AI_MAX_MODEL_STEPS_KEY = "ai_max_model_steps";
const AI_MAX_MODEL_STEPS_DEFAULT = 6;

export function aiMaxModelSteps(): number {
  const parsed = aiMaxModelStepsSchema.safeParse(setting(AI_MAX_MODEL_STEPS_KEY));
  return parsed.success ? parsed.data : AI_MAX_MODEL_STEPS_DEFAULT;
}

const aiMaxSimultaneousReadsSchema = z.coerce.number().int().min(1).max(8);
const AI_MAX_SIMULTANEOUS_READS_KEY = "ai_max_simultaneous_reads";
const AI_MAX_SIMULTANEOUS_READS_DEFAULT = 4;

export function aiMaxSimultaneousReads(): number {
  const parsed = aiMaxSimultaneousReadsSchema.safeParse(setting(AI_MAX_SIMULTANEOUS_READS_KEY));
  return parsed.success ? parsed.data : AI_MAX_SIMULTANEOUS_READS_DEFAULT;
}

const aiMaxPendingPlannersSchema = z.coerce.number().int().min(1).max(16);
const AI_MAX_PENDING_PLANNERS_KEY = "ai_max_pending_planners";
const AI_MAX_PENDING_PLANNERS_DEFAULT = 8;

export function aiMaxPendingPlanners(): number {
  const parsed = aiMaxPendingPlannersSchema.safeParse(setting(AI_MAX_PENDING_PLANNERS_KEY));
  return parsed.success ? parsed.data : AI_MAX_PENDING_PLANNERS_DEFAULT;
}

const aiReadToolsLimitSchema = z.coerce.number().int().min(5).max(40);
const AI_READ_TOOLS_LIMIT_KEY = "ai_read_tools_limit";
const AI_READ_TOOLS_LIMIT_DEFAULT = 20;

export function aiReadToolsLimit(): number {
  const parsed = aiReadToolsLimitSchema.safeParse(setting(AI_READ_TOOLS_LIMIT_KEY));
  return parsed.success ? parsed.data : AI_READ_TOOLS_LIMIT_DEFAULT;
}

const aiCapabilitySearchLimitSchema = z.coerce.number().int().min(4).max(32);
const AI_CAPABILITY_SEARCH_LIMIT_KEY = "ai_capability_search_limit";
const AI_CAPABILITY_SEARCH_LIMIT_DEFAULT = 16;

export function aiCapabilitySearchLimit(): number {
  const parsed = aiCapabilitySearchLimitSchema.safeParse(setting(AI_CAPABILITY_SEARCH_LIMIT_KEY));
  return parsed.success ? parsed.data : AI_CAPABILITY_SEARCH_LIMIT_DEFAULT;
}

const aiConversationHistoryLimitSchema = z.coerce.number().int().min(5).max(50);
const AI_CONVERSATION_HISTORY_LIMIT_KEY = "ai_conversation_history_limit";
const AI_CONVERSATION_HISTORY_LIMIT_DEFAULT = 20;

export function aiConversationHistoryLimit(): number {
  const parsed = aiConversationHistoryLimitSchema.safeParse(
    setting(AI_CONVERSATION_HISTORY_LIMIT_KEY),
  );
  return parsed.success ? parsed.data : AI_CONVERSATION_HISTORY_LIMIT_DEFAULT;
}

// ── Plan lifecycle ──────────────────────────────────────────────────────────

const aiPlanExpiryMinutesSchema = z.coerce.number().int().min(5).max(30);
const AI_PLAN_EXPIRY_MINUTES_KEY = "ai_plan_expiry_minutes";
const AI_PLAN_EXPIRY_MINUTES_DEFAULT = 10;

export function aiPlanExpiryMinutes(): number {
  const parsed = aiPlanExpiryMinutesSchema.safeParse(setting(AI_PLAN_EXPIRY_MINUTES_KEY));
  return parsed.success ? parsed.data : AI_PLAN_EXPIRY_MINUTES_DEFAULT;
}

export function aiPlanExpiryMs(): number {
  return aiPlanExpiryMinutes() * 60_000;
}

const aiMaxPlanLifetimeMinutesSchema = z.coerce.number().int().min(10).max(60);
const AI_MAX_PLAN_LIFETIME_MINUTES_KEY = "ai_max_plan_lifetime_minutes";
const AI_MAX_PLAN_LIFETIME_MINUTES_DEFAULT = 30;

export function aiMaxPlanLifetimeMinutes(): number {
  const parsed = aiMaxPlanLifetimeMinutesSchema.safeParse(
    setting(AI_MAX_PLAN_LIFETIME_MINUTES_KEY),
  );
  return parsed.success ? parsed.data : AI_MAX_PLAN_LIFETIME_MINUTES_DEFAULT;
}

export function aiMaxPlanLifetimeMs(): number {
  return aiMaxPlanLifetimeMinutes() * 60_000;
}

const aiResourceLockTtlMinutesSchema = z.coerce.number().int().min(5).max(30);
const AI_RESOURCE_LOCK_TTL_MINUTES_KEY = "ai_resource_lock_ttl_minutes";
const AI_RESOURCE_LOCK_TTL_MINUTES_DEFAULT = 10;

export function aiResourceLockTtlMinutes(): number {
  const parsed = aiResourceLockTtlMinutesSchema.safeParse(
    setting(AI_RESOURCE_LOCK_TTL_MINUTES_KEY),
  );
  return parsed.success ? parsed.data : AI_RESOURCE_LOCK_TTL_MINUTES_DEFAULT;
}

export function aiResourceLockTtlMs(): number {
  return aiResourceLockTtlMinutes() * 60_000;
}

const aiLockRenewalSecondsSchema = z.coerce.number().int().min(30).max(300);
const AI_LOCK_RENEWAL_SECONDS_KEY = "ai_lock_renewal_seconds";
const AI_LOCK_RENEWAL_SECONDS_DEFAULT = 60;

export function aiLockRenewalSeconds(): number {
  const parsed = aiLockRenewalSecondsSchema.safeParse(setting(AI_LOCK_RENEWAL_SECONDS_KEY));
  return parsed.success ? parsed.data : AI_LOCK_RENEWAL_SECONDS_DEFAULT;
}

export function aiLockRenewalMs(): number {
  return aiLockRenewalSeconds() * 1000;
}

// ── Security ────────────────────────────────────────────────────────────────

const aiReauthTtlMinutesSchema = z.coerce.number().int().min(2).max(15);
const AI_REAUTH_TTL_MINUTES_KEY = "ai_reauth_ttl_minutes";
const AI_REAUTH_TTL_MINUTES_DEFAULT = 5;

export function aiReauthTtlMinutes(): number {
  const parsed = aiReauthTtlMinutesSchema.safeParse(setting(AI_REAUTH_TTL_MINUTES_KEY));
  return parsed.success ? parsed.data : AI_REAUTH_TTL_MINUTES_DEFAULT;
}

export function aiReauthTtlMs(): number {
  return aiReauthTtlMinutes() * 60_000;
}

const aiSecretRefTtlMinutesSchema = z.coerce.number().int().min(5).max(60);
const AI_SECRET_REF_TTL_MINUTES_KEY = "ai_secret_ref_ttl_minutes";
const AI_SECRET_REF_TTL_MINUTES_DEFAULT = 30;

export function aiSecretRefTtlMinutes(): number {
  const parsed = aiSecretRefTtlMinutesSchema.safeParse(setting(AI_SECRET_REF_TTL_MINUTES_KEY));
  return parsed.success ? parsed.data : AI_SECRET_REF_TTL_MINUTES_DEFAULT;
}

export function aiSecretRefTtlMs(): number {
  return aiSecretRefTtlMinutes() * 60_000;
}

// ── Size limits ─────────────────────────────────────────────────────────────

const aiMaxChatInputBytesSchema = z.coerce.number().int().min(4096).max(65536);
const AI_MAX_CHAT_INPUT_BYTES_KEY = "ai_max_chat_input_bytes";
const AI_MAX_CHAT_INPUT_BYTES_DEFAULT = 16384;

export function aiMaxChatInputBytes(): number {
  const parsed = aiMaxChatInputBytesSchema.safeParse(setting(AI_MAX_CHAT_INPUT_BYTES_KEY));
  return parsed.success ? parsed.data : AI_MAX_CHAT_INPUT_BYTES_DEFAULT;
}

const aiMaxMessageBytesSchema = z.coerce.number().int().min(16384).max(131072);
const AI_MAX_MESSAGE_BYTES_KEY = "ai_max_message_bytes";
const AI_MAX_MESSAGE_BYTES_DEFAULT = 65536;

export function aiMaxMessageBytes(): number {
  const parsed = aiMaxMessageBytesSchema.safeParse(setting(AI_MAX_MESSAGE_BYTES_KEY));
  return parsed.success ? parsed.data : AI_MAX_MESSAGE_BYTES_DEFAULT;
}

const aiProviderResponseMaxBytesSchema = z.coerce.number().int().min(262144).max(4194304);
const AI_PROVIDER_RESPONSE_MAX_BYTES_KEY = "ai_provider_response_max_bytes";
const AI_PROVIDER_RESPONSE_MAX_BYTES_DEFAULT = 1048576;

export function aiProviderResponseMaxBytes(): number {
  const parsed = aiProviderResponseMaxBytesSchema.safeParse(
    setting(AI_PROVIDER_RESPONSE_MAX_BYTES_KEY),
  );
  return parsed.success ? parsed.data : AI_PROVIDER_RESPONSE_MAX_BYTES_DEFAULT;
}

// ── Bulk read/write ─────────────────────────────────────────────────────────

export interface AiSettings {
  maxModelSteps: number;
  maxSimultaneousReads: number;
  maxPendingPlanners: number;
  readToolsLimit: number;
  capabilitySearchLimit: number;
  conversationHistoryLimit: number;
  planExpiryMinutes: number;
  maxPlanLifetimeMinutes: number;
  resourceLockTtlMinutes: number;
  lockRenewalSeconds: number;
  reauthTtlMinutes: number;
  secretRefTtlMinutes: number;
  maxChatInputBytes: number;
  maxMessageBytes: number;
  providerResponseMaxBytes: number;
}

export function getAiSettings(): AiSettings {
  return {
    maxModelSteps: aiMaxModelSteps(),
    maxSimultaneousReads: aiMaxSimultaneousReads(),
    maxPendingPlanners: aiMaxPendingPlanners(),
    readToolsLimit: aiReadToolsLimit(),
    capabilitySearchLimit: aiCapabilitySearchLimit(),
    conversationHistoryLimit: aiConversationHistoryLimit(),
    planExpiryMinutes: aiPlanExpiryMinutes(),
    maxPlanLifetimeMinutes: aiMaxPlanLifetimeMinutes(),
    resourceLockTtlMinutes: aiResourceLockTtlMinutes(),
    lockRenewalSeconds: aiLockRenewalSeconds(),
    reauthTtlMinutes: aiReauthTtlMinutes(),
    secretRefTtlMinutes: aiSecretRefTtlMinutes(),
    maxChatInputBytes: aiMaxChatInputBytes(),
    maxMessageBytes: aiMaxMessageBytes(),
    providerResponseMaxBytes: aiProviderResponseMaxBytes(),
  };
}

const settingEntries: Array<{
  key: string;
  field: keyof AiSettings;
  schema: z.ZodType<number>;
}> = [
  { key: AI_MAX_MODEL_STEPS_KEY, field: "maxModelSteps", schema: aiMaxModelStepsSchema },
  {
    key: AI_MAX_SIMULTANEOUS_READS_KEY,
    field: "maxSimultaneousReads",
    schema: aiMaxSimultaneousReadsSchema,
  },
  {
    key: AI_MAX_PENDING_PLANNERS_KEY,
    field: "maxPendingPlanners",
    schema: aiMaxPendingPlannersSchema,
  },
  { key: AI_READ_TOOLS_LIMIT_KEY, field: "readToolsLimit", schema: aiReadToolsLimitSchema },
  {
    key: AI_CAPABILITY_SEARCH_LIMIT_KEY,
    field: "capabilitySearchLimit",
    schema: aiCapabilitySearchLimitSchema,
  },
  {
    key: AI_CONVERSATION_HISTORY_LIMIT_KEY,
    field: "conversationHistoryLimit",
    schema: aiConversationHistoryLimitSchema,
  },
  {
    key: AI_PLAN_EXPIRY_MINUTES_KEY,
    field: "planExpiryMinutes",
    schema: aiPlanExpiryMinutesSchema,
  },
  {
    key: AI_MAX_PLAN_LIFETIME_MINUTES_KEY,
    field: "maxPlanLifetimeMinutes",
    schema: aiMaxPlanLifetimeMinutesSchema,
  },
  {
    key: AI_RESOURCE_LOCK_TTL_MINUTES_KEY,
    field: "resourceLockTtlMinutes",
    schema: aiResourceLockTtlMinutesSchema,
  },
  {
    key: AI_LOCK_RENEWAL_SECONDS_KEY,
    field: "lockRenewalSeconds",
    schema: aiLockRenewalSecondsSchema,
  },
  { key: AI_REAUTH_TTL_MINUTES_KEY, field: "reauthTtlMinutes", schema: aiReauthTtlMinutesSchema },
  {
    key: AI_SECRET_REF_TTL_MINUTES_KEY,
    field: "secretRefTtlMinutes",
    schema: aiSecretRefTtlMinutesSchema,
  },
  {
    key: AI_MAX_CHAT_INPUT_BYTES_KEY,
    field: "maxChatInputBytes",
    schema: aiMaxChatInputBytesSchema,
  },
  { key: AI_MAX_MESSAGE_BYTES_KEY, field: "maxMessageBytes", schema: aiMaxMessageBytesSchema },
  {
    key: AI_PROVIDER_RESPONSE_MAX_BYTES_KEY,
    field: "providerResponseMaxBytes",
    schema: aiProviderResponseMaxBytesSchema,
  },
];

export function updateAiSettings(
  input: Partial<AiSettings>,
  actor: { id: string; ip?: string | null },
): AiSettings {
  const changes: Array<{ key: string; field: string; value: number }> = [];
  for (const entry of settingEntries) {
    const raw = input[entry.field];
    if (raw === undefined) continue;
    const value = entry.schema.parse(raw);
    setSetting(entry.key, String(value));
    changes.push({ key: entry.key, field: entry.field, value });
  }
  if (changes.length > 0) {
    audit({
      userId: actor.id,
      ip: actor.ip,
      action: "settings.ai_settings_updated",
      entityType: "setting",
      entityId: "ai_settings",
      details: Object.fromEntries(changes.map((change) => [change.field, change.value])),
    });
  }
  return getAiSettings();
}
