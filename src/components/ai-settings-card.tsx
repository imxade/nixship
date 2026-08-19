"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";

interface AiSettings {
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

const fields: Array<{
  key: keyof AiSettings;
  label: string;
  group: string;
  min: number;
  max: number;
  unit?: string;
}> = [
  { key: "maxModelSteps", label: "Max model steps per request", group: "Planner", min: 2, max: 12 },
  {
    key: "maxSimultaneousReads",
    label: "Max simultaneous read calls",
    group: "Planner",
    min: 1,
    max: 8,
  },
  {
    key: "maxPendingPlanners",
    label: "Max queued planner requests",
    group: "Planner",
    min: 1,
    max: 16,
  },
  { key: "readToolsLimit", label: "Read tools exposed to model", group: "Planner", min: 5, max: 40 },
  {
    key: "capabilitySearchLimit",
    label: "Capability search results",
    group: "Planner",
    min: 4,
    max: 32,
  },
  {
    key: "conversationHistoryLimit",
    label: "Conversation history window",
    group: "Planner",
    min: 5,
    max: 50,
    unit: "messages",
  },
  {
    key: "planExpiryMinutes",
    label: "Plan expiry",
    group: "Plan lifecycle",
    min: 5,
    max: 30,
    unit: "min",
  },
  {
    key: "maxPlanLifetimeMinutes",
    label: "Max plan lifetime",
    group: "Plan lifecycle",
    min: 10,
    max: 60,
    unit: "min",
  },
  {
    key: "resourceLockTtlMinutes",
    label: "Resource lock TTL",
    group: "Plan lifecycle",
    min: 5,
    max: 30,
    unit: "min",
  },
  {
    key: "lockRenewalSeconds",
    label: "Lock renewal interval",
    group: "Plan lifecycle",
    min: 30,
    max: 300,
    unit: "sec",
  },
  {
    key: "reauthTtlMinutes",
    label: "Re-authentication grant TTL",
    group: "Security",
    min: 2,
    max: 15,
    unit: "min",
  },
  {
    key: "secretRefTtlMinutes",
    label: "Secure input reference TTL",
    group: "Security",
    min: 5,
    max: 60,
    unit: "min",
  },
  {
    key: "maxChatInputBytes",
    label: "Max chat input size",
    group: "Size limits",
    min: 4096,
    max: 65536,
    unit: "bytes",
  },
  {
    key: "maxMessageBytes",
    label: "Max stored message size",
    group: "Size limits",
    min: 16384,
    max: 131072,
    unit: "bytes",
  },
  {
    key: "providerResponseMaxBytes",
    label: "Max provider response size",
    group: "Size limits",
    min: 262144,
    max: 4194304,
    unit: "bytes",
  },
];

const groups = [...new Set(fields.map((f) => f.group))];

export function AiSettingsCard() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await apiFetch<AiSettings>("/api/ai/settings"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load AI settings");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    const form = new FormData(event.currentTarget);
    const patch: Partial<AiSettings> = {};
    for (const field of fields) {
      const raw = form.get(field.key);
      if (raw !== null && raw !== "") {
        (patch as Record<string, number>)[field.key] = Number(raw);
      }
    }
    try {
      setSettings(
        await apiFetch<AiSettings>("/api/ai/settings", {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      );
      setSuccess("AI settings saved.");
      setTimeout(() => setSuccess(""), 3000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save AI settings");
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return null;

  return (
    <section className="card mb-6 border border-base-300 bg-base-100">
      <div className="card-body">
        <h2 className="card-title">AI planner settings</h2>
        <p className="text-sm text-base-content/65">
          Operational limits for the AI planning loop, plan lifecycle, security gates and size
          boundaries. Changes take effect on the next planner request.
        </p>
        {error && (
          <div className="alert alert-error mt-2">
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="alert alert-success mt-2">
            <span>{success}</span>
          </div>
        )}
        <form onSubmit={handleSubmit} className="mt-3 space-y-5">
          {groups.map((group) => (
            <fieldset key={group} className="rounded-box border border-base-300 p-4">
              <legend className="px-2 text-sm font-semibold">{group}</legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {fields
                  .filter((f) => f.group === group)
                  .map((field) => (
                    <label key={field.key} className="form-control">
                      <span className="label-text mb-1 text-xs">
                        {field.label}
                        {field.unit && (
                          <span className="text-base-content/50"> ({field.unit})</span>
                        )}
                      </span>
                      <input
                        name={field.key}
                        type="number"
                        min={field.min}
                        max={field.max}
                        step={1}
                        required
                        defaultValue={settings[field.key]}
                        className="input input-bordered input-sm"
                      />
                    </label>
                  ))}
              </div>
            </fieldset>
          ))}
          <button type="submit" disabled={busy} className="btn btn-primary btn-sm">
            {busy ? <span className="loading loading-spinner" /> : "Save AI settings"}
          </button>
        </form>
      </div>
    </section>
  );
}
