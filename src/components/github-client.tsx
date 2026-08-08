"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { GitHubConnectButton } from "./github-connect-button";
import { PageHeading } from "./page-heading";

type Status = {
  connected: boolean;
  canManage: boolean;
  app: null | { slug: string; htmlUrl: string; installUrl: string };
  installations: Array<{
    id: number;
    account_login: string;
    account_type: string;
    repository_selection: string;
    suspended_at: string | null;
  }>;
  webhook: {
    active: boolean;
    route: null | { baseUrl: string; kind: string; stable: boolean };
    reconciliationSeconds: number;
  };
};
export function GitHubClient() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<Status>("/api/github/status"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function sync() {
    setBusy(true);
    try {
      await apiFetch("/api/github/sync", { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="GitHub"
        description="Use a node-owned GitHub App to browse selected repositories and receive signed push events. When this node is LAN-only, periodic reconciliation still detects branch changes."
        actions={
          status?.connected && status.canManage ? (
            <button type="button" disabled={busy} className="btn" onClick={() => void sync()}>
              Sync installations
            </button>
          ) : undefined
        }
      />
      {error && (
        <div className="alert alert-error mb-5">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {!status ? (
        !error && <span className="loading loading-spinner loading-lg" />
      ) : status.connected ? (
        <div className="space-y-5">
          <div className="card border border-base-300 bg-base-100">
            <div className="card-body">
              <h2 className="card-title">GitHub App connected</h2>
              <p>
                <a className="link" href={status.app?.htmlUrl} target="_blank" rel="noreferrer">
                  {status.app?.slug}
                </a>
              </p>
              <div className={`alert ${status.webhook.active ? "alert-success" : "alert-warning"}`}>
                <div>
                  <div className="font-medium">
                    {status.webhook.active
                      ? "Signed push webhooks are enabled."
                      : "No public webhook route is available."}
                  </div>
                  <div className="mt-1 text-sm">
                    {status.webhook.route ? (
                      <>
                        GitHub delivers to{" "}
                        <a
                          className="link font-mono"
                          href={status.webhook.route.baseUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {status.webhook.route.baseUrl}
                        </a>
                        {status.webhook.route.stable
                          ? ". This stable route is preferred."
                          : ". This temporary route is updated automatically when it changes."}
                      </>
                    ) : (
                      "Pushes are still discovered by periodic repository reconciliation."
                    )}
                  </div>
                  <div className="mt-1 text-xs opacity-70">
                    Reconciliation runs every {status.webhook.reconciliationSeconds} seconds as a
                    safety net even when webhooks are active.
                  </div>
                </div>
              </div>
              <div className="card-actions">
                <a className="btn btn-primary" href={status.app?.installUrl}>
                  Install or change repository access
                </a>
              </div>
            </div>
          </div>
          <div className="card border border-base-300 bg-base-100">
            <div className="card-body">
              <h2 className="card-title">Installations</h2>
              {status.installations.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between border-b border-base-300 py-3 last:border-0"
                >
                  <div>
                    <div className="font-medium">{item.account_login}</div>
                    <div className="text-sm text-base-content/60">
                      {item.account_type} · {item.repository_selection}
                    </div>
                  </div>
                  <span className={`badge ${item.suspended_at ? "badge-error" : "badge-success"}`}>
                    {item.suspended_at ? "suspended" : "active"}
                  </span>
                </div>
              ))}
              {status.installations.length === 0 && (
                <p className="text-base-content/60">
                  Install the GitHub App on an account, then synchronize.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="hero min-h-[45vh] rounded-box border border-dashed border-base-300 bg-base-100">
          <div className="hero-content text-center">
            <div className="max-w-xl">
              <h2 className="text-2xl font-bold">Connect GitHub</h2>
              <p className="mt-3 text-base-content/65">
                Nix Ship creates a GitHub App preconfigured with repository read access and signed
                push events. You choose which repositories it can access.
              </p>
              {status.canManage ? (
                <GitHubConnectButton
                  className="btn btn-primary mt-6"
                  label="Create GitHub App"
                  onError={setError}
                />
              ) : (
                <div className="alert mt-6 text-left">
                  An owner or administrator must connect the GitHub App.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
