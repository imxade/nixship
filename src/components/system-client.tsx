"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch, formatBytes } from "@/lib/client-api";
import { type AccessLink, AccessLinks } from "./access-links";
import { PageHeading } from "./page-heading";
import { QuickTunnelNotice, type QuickTunnelState } from "./quick-tunnel-notice";

type Status = {
  host: {
    hostname: string;
    platform: string;
    architecture: string;
    node: string;
    nixSystem: string | null;
  };
  metric: null | {
    cpuPercent: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    freeDiskBytes: number;
    loadAverage: number[];
    uptimeSeconds: number;
  };
  settings: { activeDeploymentLimit: number };
  github: {
    connected: boolean;
    webhookRoute: null | { baseUrl: string; kind: string; stable: boolean };
    reconciliationSeconds: number;
  };
  cloudflare: { configured: boolean; enabled: boolean; running: boolean };
  quickTunnels: {
    enabled: boolean;
    routes: Array<QuickTunnelState & { key: string; targetType: string }>;
  };
  accessLinks: AccessLink[];
};

export function SystemClient() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await apiFetch<Status>("/api/system/status"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Load failed");
    }
  }, []);
  useEffect(() => {
    void load();
    const source = new EventSource("/api/events?scope=system");
    source.addEventListener("metric", () => void load());
    source.addEventListener("quick_tunnel.ready", () => void load());
    source.addEventListener("quick_tunnel.stopped", () => void load());
    const timer = setInterval(() => void load(), 5000);
    return () => {
      source.close();
      clearInterval(timer);
    };
  }, [load]);
  async function saveDeploymentLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await apiFetch("/api/system/settings", {
        method: "PATCH",
        body: JSON.stringify({ activeDeploymentLimit: form.get("activeDeploymentLimit") }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save deployment retention");
    } finally {
      setBusy(false);
    }
  }
  const dashboardTunnel =
    data?.quickTunnels.routes.find((route) => route.targetType === "dashboard") ?? null;
  const activeTemporaryRoutes =
    data?.quickTunnels.routes.filter((route) => route.running && route.url).length ?? 0;
  return (
    <>
      <PageHeading
        title="System"
        description="Current host health, dashboard access links, and public routing status."
      />
      {error && (
        <div className="alert alert-error mb-5">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {!data ? (
        !error && <span className="loading loading-spinner loading-lg" />
      ) : (
        <>
          <section className="card mb-6 border border-base-300 bg-base-100">
            <div className="card-body">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="card-title">Dashboard access</h2>
                  <p className="text-sm text-base-content/60">Available dashboard URLs.</p>
                </div>
              </div>
              <AccessLinks links={data.accessLinks} />
              <QuickTunnelNotice
                route={dashboardTunnel}
                activeMessage="This temporary URL is public, but the dashboard still requires Nix Ship authentication."
              />
            </div>
          </section>

          <div className="metric-grid mb-6">
            <div className="stat rounded-box border border-base-300 bg-base-100">
              <div className="stat-title">CPU</div>
              <div className="stat-value text-3xl">
                {data.metric?.cpuPercent?.toFixed(1) ?? "—"}%
              </div>
            </div>
            <div className="stat rounded-box border border-base-300 bg-base-100">
              <div className="stat-title">Memory</div>
              <div className="stat-value text-2xl">{formatBytes(data.metric?.memoryUsedBytes)}</div>
              <div className="stat-desc">of {formatBytes(data.metric?.memoryTotalBytes)}</div>
            </div>
            <div className="stat rounded-box border border-base-300 bg-base-100">
              <div className="stat-title">Free disk</div>
              <div className="stat-value text-2xl">{formatBytes(data.metric?.freeDiskBytes)}</div>
            </div>
            <div className="stat rounded-box border border-base-300 bg-base-100">
              <div className="stat-title">Load</div>
              <div className="stat-value text-2xl">
                {data.metric?.loadAverage?.map((value) => value.toFixed(2)).join(" · ") || "—"}
              </div>
            </div>
          </div>
          <section className="card mb-6 border border-base-300 bg-base-100">
            <div className="card-body">
              <h2 className="card-title">Active deployment retention</h2>
              <p className="text-sm text-base-content/65">
                This global limit is applied independently to each project. When a project exceeds
                it, the oldest active deployment and its temporary tunnel are stopped while history
                remains available.
              </p>
              <form onSubmit={saveDeploymentLimit} className="mt-2 flex flex-wrap items-end gap-3">
                <label className="form-control max-w-xs">
                  <span className="label-text mb-1">Active deployments per project</span>
                  <input
                    name="activeDeploymentLimit"
                    type="number"
                    min="1"
                    max="20"
                    required
                    defaultValue={data.settings.activeDeploymentLimit}
                    className="input input-bordered"
                  />
                </label>
                <button type="submit" disabled={busy} className="btn btn-primary">
                  {busy ? <span className="loading loading-spinner" /> : "Save limit"}
                </button>
              </form>
            </div>
          </section>
          <div className="grid min-w-0 gap-5 lg:grid-cols-2">
            <div className="card min-w-0 overflow-hidden border border-base-300 bg-base-100">
              <div className="card-body">
                <h2 className="card-title">Host</h2>
                <dl className="grid min-w-0 gap-x-5 gap-y-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)] [&_dd]:min-w-0 [&_dd]:break-words">
                  <dt className="text-base-content/55">Hostname</dt>
                  <dd>{data.host.hostname}</dd>
                  <dt className="text-base-content/55">Platform</dt>
                  <dd>
                    {data.host.platform} / {data.host.architecture}
                  </dd>
                  <dt className="text-base-content/55">Nix system</dt>
                  <dd className="break-all font-mono">{data.host.nixSystem || "Unavailable"}</dd>
                  <dt className="text-base-content/55">Node.js</dt>
                  <dd className="font-mono">{data.host.node}</dd>
                </dl>
              </div>
            </div>
            <div className="card min-w-0 overflow-hidden border border-base-300 bg-base-100">
              <div className="card-body">
                <h2 className="card-title">Automation and routing</h2>
                <div className="flex min-w-0 flex-wrap justify-between gap-3">
                  <span>GitHub</span>
                  <span
                    className={`badge ${data.github.connected ? "badge-success" : "badge-ghost"}`}
                  >
                    {data.github.connected ? "connected" : "not connected"}
                  </span>
                </div>
                <div className="flex min-w-0 flex-wrap justify-between gap-3">
                  <span>Named Cloudflare tunnel</span>
                  <span
                    className={`badge ${data.cloudflare.running ? "badge-success" : data.cloudflare.configured ? "badge-warning" : "badge-ghost"}`}
                  >
                    {data.cloudflare.running
                      ? "running"
                      : data.cloudflare.configured
                        ? "configured"
                        : "not connected"}
                  </span>
                </div>
                {data.quickTunnels.enabled && (
                  <div className="flex min-w-0 flex-wrap justify-between gap-3">
                    <span>Temporary public URLs</span>
                    <span
                      className={`badge ${activeTemporaryRoutes > 0 ? "badge-success" : "badge-ghost"}`}
                    >
                      {activeTemporaryRoutes} active
                    </span>
                  </div>
                )}
                <div className="mt-4 rounded-box border border-base-300 p-3 text-sm">
                  <div className="font-medium">Git deployment detection</div>
                  <p className="mt-1 text-base-content/65">
                    Signed webhook target:{" "}
                    {data.github.webhookRoute ? (
                      <a
                        className="link break-all font-mono"
                        href={`${data.github.webhookRoute.baseUrl}/api/github/webhook`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {data.github.webhookRoute.baseUrl}/api/github/webhook
                      </a>
                    ) : (
                      "not available"
                    )}
                    . Periodic Git reconciliation runs every {data.github.reconciliationSeconds}{" "}
                    seconds as a safety net. LAN addresses are never registered as external webhook
                    targets.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
