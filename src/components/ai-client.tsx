"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { AiProvidersCard } from "./ai-providers-card";
import { AiSettingsCard } from "./ai-settings-card";
import { PageHeading } from "./page-heading";

interface AiStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  remote: boolean;
}

export function AiClient() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<AiStatus>("/api/ai/status"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load AI status");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeading
        title="AI Assistant & Planner"
        description="Configure AI operational boundaries, agentic planning loop limits, plan lifecycle windows, and size limits."
      />
      {error && (
        <div className="alert alert-error mb-5">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {status && (
        <div className="metric-grid mb-6">
          <div className="stat rounded-box border border-base-300 bg-base-100">
            <div className="stat-title">Status</div>
            <div className="stat-value text-2xl">
              {status.configured ? "Configured" : "Not configured"}
            </div>
            <div className="stat-desc">
              {status.configured
                ? status.remote
                  ? "Remote endpoint"
                  : "Local endpoint"
                : "No default profile"}
            </div>
          </div>
          <div className="stat rounded-box border border-base-300 bg-base-100">
            <div className="stat-title">Active Provider</div>
            <div className="stat-value truncate text-2xl">{status.provider ?? "—"}</div>
            <div className="stat-desc">Primary AI backend</div>
          </div>
          <div className="stat rounded-box border border-base-300 bg-base-100">
            <div className="stat-title">Active Model</div>
            <div className="stat-value truncate text-2xl">{status.model ?? "—"}</div>
            <div className="stat-desc">Planning & conversation model</div>
          </div>
        </div>
      )}
      <AiProvidersCard onUpdated={() => void load()} />
      <AiSettingsCard />
    </>
  );
}
