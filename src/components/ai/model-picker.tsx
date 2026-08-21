"use client";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/client-api";

interface ModelProfile {
  id: string;
  modelId: string;
  displayName: string;
  answerCapable: boolean;
  actionPlannerCapable: boolean;
  conversationDefault: boolean;
  actionPlannerDefault: boolean;
}

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelProfile[];
}

interface ModelInventory {
  runtime: { enabled: boolean; running: boolean };
  local: Array<{
    name: string;
    sizeBytes: number;
    parameterSize: string | null;
    quantization: string | null;
  }>;
  providers: Provider[];
  curated: Array<{
    modelId: string;
    displayName: string;
    approximateSizeBytes: number;
    resourceClass: string;
  }>;
}

export function ModelPicker({
  conversationId,
  disabled,
}: {
  conversationId: string | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullStatus, setPullStatus] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setInventory(await apiFetch<ModelInventory>("/api/ai/models"));
    } catch (cause: unknown) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadInventory();
  }, [open, loadInventory]);

  const profiles = useMemo(
    () =>
      (inventory?.providers ?? []).flatMap((provider) =>
        provider.models.map((model) => ({ ...model, providerName: provider.name })),
      ),
    [inventory],
  );
  useEffect(() => {
    if (!selectedProfileId) {
      setSelectedProfileId(profiles.find((profile) => profile.conversationDefault)?.id ?? null);
    }
  }, [profiles, selectedProfileId]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProfiles = profiles.filter((profile) =>
    `${profile.displayName} ${profile.modelId} ${profile.providerName}`
      .toLowerCase()
      .includes(normalizedQuery),
  );
  const visibleLocal = (inventory?.local ?? []).filter((model) =>
    model.name.toLowerCase().includes(normalizedQuery),
  );
  const visibleCurated = (inventory?.curated ?? []).filter(
    (model) =>
      !inventory?.local.some(
        (installed) =>
          installed.name === model.modelId || installed.name === `${model.modelId}:latest`,
      ) && `${model.displayName} ${model.modelId}`.toLowerCase().includes(normalizedQuery),
  );
  const directTag = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}(?::[A-Za-z0-9._-]{1,100})?$/.test(
    query.trim(),
  )
    ? query.trim()
    : null;
  const active = profiles.find((profile) => profile.id === selectedProfileId);

  async function select(profile: ModelProfile) {
    if (!conversationId) return;
    setLoading(true);
    setError("");
    try {
      await apiFetch(`/api/ai/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ modelProfileId: profile.id }),
      });
      setSelectedProfileId(profile.id);
      setOpen(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function pullModel(model: string) {
    setPulling(model);
    setPullPercent(null);
    setPullStatus("Starting…");
    setError("");
    try {
      const response = await fetch("/api/ai/runtime/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        credentials: "same-origin",
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          (payload as { error?: { message?: string } } | null)?.error?.message ??
            `Download failed (${response.status})`,
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const eventMatch = /^event: (.+)$/m.exec(raw);
          const dataMatch = /^data: (.+)$/m.exec(raw);
          if (eventMatch && dataMatch) {
            const event = eventMatch[1];
            const data = JSON.parse(dataMatch[1] ?? "{}") as Record<string, unknown>;
            if (event === "progress") {
              setPullPercent((data.percent as number | null) ?? null);
              setPullStatus((data.status as string | null) ?? "Downloading…");
            } else if (event === "done") {
              setPullStatus("Complete");
            } else if (event === "error") {
              throw new Error((data.message as string) || "Download failed");
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      await loadInventory();
    } catch (cause: unknown) {
      setError(errorText(cause));
    } finally {
      setPulling(null);
      setPullPercent(null);
      setPullStatus(null);
    }
  }

  async function removeModel(model: string) {
    setRemoving(model);
    setError("");
    try {
      await apiFetch("/api/ai/runtime/remove", {
        method: "POST",
        body: JSON.stringify({ model }),
      });
      await loadInventory();
    } catch (cause: unknown) {
      setError(errorText(cause));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="btn btn-ghost btn-xs max-w-56"
        disabled={disabled || !conversationId}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        Model: <span className="truncate">{active?.displayName ?? "Default"}</span> ▾
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-[min(28rem,calc(100vw-2rem))] rounded-box border border-base-300 bg-base-100 p-3 shadow-2xl">
          <label className="input input-sm input-bordered flex items-center gap-2">
            <span className="sr-only">Search AI models</span>
            <input
              type="search"
              className="grow"
              placeholder="Search or enter an Ollama tag…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="mt-3 max-h-80 space-y-3 overflow-y-auto">
            {loading && <span className="loading loading-dots loading-sm" />}
            {error && <p className="text-sm text-error">{error}</p>}
            {pulling && (
              <div className="rounded-box border border-primary/30 bg-primary/5 p-2">
                <div className="mb-1 text-sm font-medium">Downloading {pulling}…</div>
                <div className="text-xs text-base-content/60">{pullStatus}</div>
                {pullPercent != null && (
                  <progress
                    className="progress progress-primary mt-1 w-full"
                    value={pullPercent}
                    max={100}
                  />
                )}
              </div>
            )}
            {visibleProfiles.length > 0 && (
              <ModelSection title="Configured">
                {visibleProfiles.map((profile) => (
                  <ModelRow
                    key={profile.id}
                    title={profile.displayName}
                    detail={`${profile.providerName} · ${profile.actionPlannerCapable ? "Agent ready" : "Answer only"}`}
                    action="Use"
                    onAction={() => void select(profile)}
                  />
                ))}
              </ModelSection>
            )}
            {visibleLocal.length > 0 && (
              <ModelSection title="Installed local">
                {visibleLocal.map((model) => {
                  const profile = profiles.find(
                    (candidate) =>
                      candidate.modelId === model.name ||
                      `${candidate.modelId}:latest` === model.name,
                  );
                  return (
                    <div key={model.name} className="rounded-box border border-base-300 p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{model.name}</div>
                          <div className="text-xs text-base-content/60">
                            {formatBytes(model.sizeBytes)} · {model.parameterSize ?? "local"} ·{" "}
                            {profile?.actionPlannerCapable ? "Agent ready" : "Answer only"}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          {profile && (
                            <button
                              type="button"
                              className="btn btn-primary btn-xs"
                              onClick={() => void select(profile)}
                            >
                              Use
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs text-error"
                            disabled={removing === model.name}
                            onClick={() => void removeModel(model.name)}
                          >
                            {removing === model.name ? "Removing…" : "Delete"}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </ModelSection>
            )}
            {visibleCurated.length > 0 && (
              <ModelSection title="Available to download">
                {visibleCurated.map((model) => (
                  <ModelRow
                    key={model.modelId}
                    title={model.displayName}
                    detail={`${formatBytes(model.approximateSizeBytes)} · ${model.resourceClass}`}
                    action={pulling === model.modelId ? "Pulling…" : "Download"}
                    disabled={pulling !== null}
                    onAction={() => void pullModel(model.modelId)}
                  />
                ))}
              </ModelSection>
            )}
            {directTag &&
              ![
                ...visibleLocal.map((model) => model.name),
                ...visibleCurated.map((model) => model.modelId),
              ]
                .map((name) => name.toLowerCase())
                .includes(directTag.toLowerCase()) && (
                <ModelSection title="Exact Ollama tag">
                  <ModelRow
                    title={directTag}
                    detail="Direct tag · size checked during pull"
                    action={pulling === directTag ? "Pulling…" : "Download"}
                    disabled={pulling !== null}
                    onAction={() => void pullModel(directTag)}
                  />
                </ModelSection>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-bold uppercase tracking-wide text-base-content/50">{title}</h3>
      {children}
    </section>
  );
}

function ModelRow({
  title,
  detail,
  action,
  disabled,
  onAction,
}: {
  title: string;
  detail: string;
  action: string;
  disabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-box border border-base-300 p-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs text-base-content/60">{detail}</div>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-xs"
        disabled={disabled}
        onClick={onAction}
      >
        {action}
      </button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${bytes} B`;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Model request failed";
}
