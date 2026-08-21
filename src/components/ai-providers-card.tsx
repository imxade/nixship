"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";

interface ModelProfile {
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

interface SafeAiProvider {
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
  models: ModelProfile[];
}

interface ProviderPreset {
  id: string;
  name: string;
  description: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  allowPrivateNetworkDefault: boolean;
  defaultModels: Array<{
    modelId: string;
    displayName: string;
    resourceClass?: "small" | "medium" | "large";
  }>;
}

interface ProvidersResponse {
  providers: SafeAiProvider[];
  presets?: ProviderPreset[];
}

export function AiProvidersCard({ onUpdated }: { onUpdated?: () => void }) {
  const [providers, setProviders] = useState<SafeAiProvider[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Form State
  const [selectedPresetId, setSelectedPresetId] = useState<string>("ollama");
  const [name, setName] = useState("Ollama (Local)");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(true);
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const [maxOutputTokens, setMaxOutputTokens] = useState(2048);
  const [modelInputs, setModelInputs] = useState<
    Array<{ id: string; modelId: string; displayName: string }>
  >([{ id: "default-1", modelId: "qwen2.5:7b", displayName: "Qwen 2.5 7B" }]);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<ProvidersResponse>("/api/ai/providers");
      setProviders(data.providers);
      if (data.presets && data.presets.length > 0) {
        setPresets(data.presets);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function handlePresetChange(presetId: string) {
    setSelectedPresetId(presetId);
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setName(preset.name);
    setBaseUrl(preset.defaultBaseUrl);
    setAllowPrivateNetwork(preset.allowPrivateNetworkDefault);
    if (preset.defaultModels.length > 0) {
      setModelInputs(
        preset.defaultModels.map((m, idx) => ({
          id: `${presetId}-${idx}`,
          modelId: m.modelId,
          displayName: m.displayName,
        })),
      );
    } else {
      setModelInputs([{ id: "custom-0", modelId: "", displayName: "" }]);
    }
  }

  async function handleAddProvider(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      let secretRef: string | null = null;
      if (apiKey.trim()) {
        const secret = await apiFetch<{ secretRef: string }>("/api/ai/secrets", {
          method: "POST",
          body: JSON.stringify({
            kind: "provider_api_key",
            scope: { type: "ai", id: baseUrl.trim() },
            value: apiKey.trim(),
          }),
        });
        secretRef = secret.secretRef;
      }
      const validModels = modelInputs
        .filter((m) => m.modelId.trim() && m.displayName.trim())
        .map((m) => ({ modelId: m.modelId.trim(), displayName: m.displayName.trim() }));
      if (validModels.length === 0) {
        throw new Error("At least one model profile is required");
      }
      await apiFetch<SafeAiProvider>("/api/ai/providers", {
        method: "POST",
        body: JSON.stringify({
          type: selectedPresetId,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          secretRef,
          allowPrivateNetwork,
          timeoutSeconds,
          maxOutputTokens,
          models: validModels,
        }),
      });
      setSuccess(`AI provider "${name.trim()}" added successfully.`);
      setShowAddModal(false);
      setApiKey("");
      await load();
      onUpdated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to add provider");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProbe(profileId: string) {
    setProbingId(profileId);
    setError("");
    setSuccess("");
    try {
      const result = await apiFetch<{ actionPlannerCapable: boolean; probeVersion: number }>(
        "/api/ai/models/probe",
        {
          method: "POST",
          body: JSON.stringify({ profileId }),
        },
      );
      setSuccess(
        result.actionPlannerCapable
          ? "Model probe passed: ready for planning and conversation."
          : "Model probe passed for chat answers (planner tools not fully supported).",
      );
      await load();
      onUpdated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Model probe failed");
    } finally {
      setProbingId(null);
    }
  }

  async function handleSetDefault(profileId: string, purpose: "conversation" | "action_planner") {
    setError("");
    setSuccess("");
    try {
      await apiFetch("/api/ai/models/default", {
        method: "POST",
        body: JSON.stringify({ profileId, purpose }),
      });
      setSuccess(
        purpose === "conversation" ? "Set default chat model." : "Set default planning model.",
      );
      await load();
      onUpdated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update default");
    }
  }

  async function handleDeleteProvider(providerId: string) {
    if (!window.confirm("Are you sure you want to delete this AI provider?")) return;
    setDeletingId(providerId);
    setError("");
    setSuccess("");
    try {
      await apiFetch(`/api/ai/providers/${providerId}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmation: `DELETE ${providerId}` }),
      });
      setSuccess("AI provider removed.");
      await load();
      onUpdated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to remove provider");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="card border border-base-300 bg-base-100 mb-6">
      <div className="card-body">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="card-title text-xl">Configured AI Providers & Models</h2>
            <p className="text-sm text-base-content/70">
              Universal multi-provider layer supporting Ollama, Anthropic Claude, Google Gemini,
              OpenAI, LiteLLM Proxy, and custom OpenAI-compatible endpoints.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddModal(true)}
          >
            + Add Provider
          </button>
        </div>

        {error && (
          <div className="alert alert-error my-3 text-sm">
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="alert alert-success my-3 text-sm">
            <span>{success}</span>
          </div>
        )}

        {loading && <div className="loading loading-dots loading-md my-4" />}

        {!loading && providers.length === 0 && (
          <div className="alert alert-info my-4 text-sm">
            No AI providers configured yet. Click <strong>+ Add Provider</strong> to configure
            Ollama, Anthropic Claude, Google Gemini, OpenAI, or a LiteLLM Proxy.
          </div>
        )}

        <div className="mt-4 space-y-4">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="rounded-box border border-base-200 bg-base-200/40 p-4 transition hover:border-base-300"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-300 pb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-base">{provider.name}</span>
                    <span className="badge badge-sm badge-outline uppercase text-xs">
                      {provider.type}
                    </span>
                    {provider.hasApiKey && (
                      <span className="badge badge-sm badge-ghost text-xs">API Key Set</span>
                    )}
                  </div>
                  <div className="truncate text-xs font-mono text-base-content/60 mt-0.5">
                    {provider.baseUrl}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs text-error"
                    disabled={deletingId === provider.id}
                    onClick={() => void handleDeleteProvider(provider.id)}
                  >
                    {deletingId === provider.id ? "Deleting…" : "Delete Provider"}
                  </button>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                <div className="text-xs font-bold uppercase tracking-wider text-base-content/50">
                  Available Models ({provider.models.length})
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {provider.models.map((model) => (
                    <div
                      key={model.id}
                      className="flex items-center justify-between rounded-box border border-base-300/80 bg-base-100 p-2.5 text-sm"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-1.5 font-medium truncate">
                          <span>{model.displayName}</span>
                          {model.conversationDefault && (
                            <span className="badge badge-xs badge-primary">Chat Default</span>
                          )}
                          {model.actionPlannerDefault && (
                            <span className="badge badge-xs badge-secondary">Planner Default</span>
                          )}
                        </div>
                        <div className="text-xs text-base-content/60 truncate font-mono">
                          {model.modelId} ·{" "}
                          {model.actionPlannerCapable ? "Agent Ready" : "Chat Only"}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          title="Test / Probe Model"
                          disabled={probingId === model.id}
                          onClick={() => void handleProbe(model.id)}
                        >
                          {probingId === model.id ? "Probing…" : "Probe"}
                        </button>
                        {!model.conversationDefault && (
                          <button
                            type="button"
                            className="btn btn-outline btn-xs"
                            title="Set as conversation default"
                            onClick={() => void handleSetDefault(model.id, "conversation")}
                          >
                            Default
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Add Provider Modal */}
        {showAddModal && (
          <div className="modal modal-open">
            <div className="modal-box max-w-xl">
              <h3 className="text-lg font-bold">Add AI Provider</h3>
              <p className="text-xs text-base-content/70 mb-4">
                Configure a provider preset or custom endpoint compatible with LiteLLM and OpenAI
                standards.
              </p>

              <form onSubmit={(e) => void handleAddProvider(e)} className="space-y-4">
                <label className="form-control">
                  <span className="label label-text font-semibold">Provider Preset</span>
                  <select
                    className="select select-bordered select-sm w-full"
                    value={selectedPresetId}
                    onChange={(e) => handlePresetChange(e.target.value)}
                  >
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="form-control">
                    <span className="label label-text font-semibold">Provider Name</span>
                    <input
                      type="text"
                      className="input input-bordered input-sm"
                      value={name}
                      required
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>

                  <label className="form-control">
                    <span className="label label-text font-semibold">
                      Base URL (OpenAI-compatible)
                    </span>
                    <input
                      type="url"
                      className="input input-bordered input-sm font-mono text-xs"
                      value={baseUrl}
                      required
                      onChange={(e) => setBaseUrl(e.target.value)}
                    />
                  </label>
                </div>

                <label className="form-control">
                  <span className="label flex justify-between">
                    <span className="label-text font-semibold">API Key / Secret</span>
                    <span className="label-text-alt text-xs text-base-content/50">
                      Encrypted at rest · never logged
                    </span>
                  </span>
                  <input
                    type="password"
                    className="input input-bordered input-sm font-mono"
                    placeholder="sk-… or leave blank for local Ollama/Proxy"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </label>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="form-control">
                    <span className="label label-text font-semibold">Timeout (seconds)</span>
                    <input
                      type="number"
                      className="input input-bordered input-sm"
                      min={5}
                      max={300}
                      value={timeoutSeconds}
                      onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
                    />
                  </label>

                  <label className="form-control">
                    <span className="label label-text font-semibold">Max Output Tokens</span>
                    <input
                      type="number"
                      className="input input-bordered input-sm"
                      min={128}
                      max={8192}
                      value={maxOutputTokens}
                      onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
                    />
                  </label>
                </div>

                <div className="form-control">
                  <label className="cursor-pointer label justify-start gap-3">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm checkbox-primary"
                      checked={allowPrivateNetwork}
                      onChange={(e) => setAllowPrivateNetwork(e.target.checked)}
                    />
                    <span className="label-text text-xs">
                      Allow Private Network / Localhost (required for local Ollama and LAN
                      endpoints)
                    </span>
                  </label>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
                      Model Profiles
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-primary"
                      onClick={() =>
                        setModelInputs((prev) => [
                          ...prev,
                          {
                            id: `model-${Date.now()}-${prev.length}`,
                            modelId: "",
                            displayName: "",
                          },
                        ])
                      }
                    >
                      + Add Model
                    </button>
                  </div>
                  {modelInputs.map((model, index) => (
                    <div key={model.id} className="flex gap-2 items-center">
                      <input
                        type="text"
                        className="input input-bordered input-sm font-mono text-xs grow"
                        placeholder="Model ID (e.g. gpt-4o, claude-3-5-sonnet)"
                        value={model.modelId}
                        required
                        onChange={(e) => {
                          const val = e.target.value;
                          setModelInputs((prev) =>
                            prev.map((item, idx) =>
                              idx === index
                                ? {
                                    ...item,
                                    modelId: val,
                                    displayName: item.displayName || val,
                                  }
                                : item,
                            ),
                          );
                        }}
                      />
                      <input
                        type="text"
                        className="input input-bordered input-sm text-xs grow"
                        placeholder="Display Name"
                        value={model.displayName}
                        required
                        onChange={(e) => {
                          const val = e.target.value;
                          setModelInputs((prev) =>
                            prev.map((item, idx) =>
                              idx === index ? { ...item, displayName: val } : item,
                            ),
                          );
                        }}
                      />
                      {modelInputs.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() =>
                            setModelInputs((prev) => prev.filter((_, idx) => idx !== index))
                          }
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="modal-action">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={submitting}
                    onClick={() => setShowAddModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={submitting || modelInputs.length === 0}
                  >
                    {submitting ? "Probing & Adding…" : "Save & Probe"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
