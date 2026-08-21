"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  type: string;
  name: string;
  baseUrl: string;
  models: ModelProfile[];
}

interface ProvidersResponse {
  providers: Provider[];
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
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<ProvidersResponse>("/api/ai/providers");
      setProviders(data.providers ?? []);
    } catch (cause: unknown) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadProviders();
  }, [open, loadProviders]);

  const profiles = useMemo(
    () =>
      providers.flatMap((provider) =>
        provider.models.map((model) => ({
          ...model,
          providerName: provider.name,
          providerType: provider.type,
        })),
      ),
    [providers],
  );

  useEffect(() => {
    if (!selectedProfileId) {
      setSelectedProfileId(profiles.find((profile) => profile.conversationDefault)?.id ?? null);
    }
  }, [profiles, selectedProfileId]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleProfiles = profiles.filter((profile) =>
    `${profile.displayName} ${profile.modelId} ${profile.providerName} ${profile.providerType}`
      .toLowerCase()
      .includes(normalizedQuery),
  );

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
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-base-content/60">
              Select AI Model
            </span>
            <Link
              href="/ai"
              className="btn btn-ghost btn-xs text-primary"
              onClick={() => setOpen(false)}
            >
              Manage Providers →
            </Link>
          </div>
          <label className="input input-sm input-bordered flex items-center gap-2">
            <span className="sr-only">Search AI models</span>
            <input
              type="search"
              className="grow"
              placeholder="Search models or providers…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="mt-3 max-h-80 space-y-3 overflow-y-auto">
            {loading && <span className="loading loading-dots loading-sm" />}
            {error && <p className="text-sm text-error">{error}</p>}
            {visibleProfiles.length > 0 ? (
              <div className="space-y-2">
                {visibleProfiles.map((profile) => (
                  <div
                    key={profile.id}
                    className="flex items-center justify-between gap-2 rounded-box border border-base-300 p-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium truncate">
                        <span>{profile.displayName}</span>
                        {profile.id === selectedProfileId && (
                          <span className="badge badge-xs badge-primary">Active</span>
                        )}
                      </div>
                      <div className="truncate text-xs text-base-content/60 font-mono">
                        {profile.providerName} · {profile.modelId} ·{" "}
                        {profile.actionPlannerCapable ? "Agent ready" : "Chat only"}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-xs shrink-0"
                      disabled={profile.id === selectedProfileId}
                      onClick={() => void select(profile)}
                    >
                      {profile.id === selectedProfileId ? "Selected" : "Use"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              !loading && (
                <div className="p-3 text-center text-xs text-base-content/60">
                  No matching models configured.{" "}
                  <Link href="/ai" className="link link-primary" onClick={() => setOpen(false)}>
                    Add a provider in Settings
                  </Link>
                  .
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Model request failed";
}
