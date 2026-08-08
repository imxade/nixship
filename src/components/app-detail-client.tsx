"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, formatBytes, formatDate } from "@/lib/client-api";
import { type AccessLink, AccessLinks } from "./access-links";
import { type DomainRoute, DomainRouteStatusBadge } from "./domain-route-status";
import { PageHeading } from "./page-heading";
import { QuickTunnelNotice, type QuickTunnelState } from "./quick-tunnel-notice";
import { StatusBadge } from "./status-badge";

type App = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  repository_url: string;
  branch: string;
  flake_output: string;
  auto_deploy: number;
  restart_policy: string;
  health_path: string;
  public_port: number | null;
  active_internal_port: number | null;
  active_deployment_id: string | null;
  updated_at: string;
};
type Deployment = {
  id: string;
  state: string;
  commit_sha: string | null;
  requested_ref: string;
  trigger: string;
  queued_at: string;
  activated_at: string | null;
  failure_message: string | null;
  resource_confidence: string;
  isProduction: boolean;
  quickTunnel: QuickTunnelState | null;
};
type Env = { key: string; secret: boolean; updatedAt: string };
type AppTab = "deployments" | "logs" | "environment" | "domains" | "settings";
type Payload = {
  app: App;
  operationalStatus: string;
  quickTunnel: QuickTunnelState | null;
  accessLinks: AccessLink[];
  domains: string[];
  cloudflare: {
    configured: boolean;
    enabled: boolean;
    running: boolean;
    routes: DomainRoute[];
  };
  environment: Env[];
  deployments: Deployment[];
  metric: null | {
    capturedAt: string;
    cpuPercent: number;
    memoryBytes: number;
    processCount: number;
  };
};

export function AppDetailClient({ appId }: { appId: string }) {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [activeTab, setActiveTab] = useState<AppTab>("deployments");
  const [logDeployment, setLogDeployment] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [logError, setLogError] = useState("");
  const [logMode, setLogMode] = useState<"stream" | "polling">("stream");
  const logRef = useRef<HTMLPreElement | null>(null);
  const load = useCallback(async () => {
    try {
      const value = await apiFetch<Payload>(`/api/apps/${appId}`);
      setData(value);
      setLogDeployment((current) => current ?? value.deployments[0]?.id ?? null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Load failed");
    }
  }, [appId]);
  useEffect(() => {
    void load();
    const source = new EventSource(`/api/events?scope=app:${appId}`);
    source.addEventListener("deployment.state", () => void load());
    source.addEventListener("deployment.queued", () => void load());
    source.addEventListener("deployment.deactivated", () => void load());
    source.addEventListener("deployment.promoted", () => void load());
    source.addEventListener("application.stopped", () => void load());
    source.addEventListener("process.exit", () => void load());
    source.addEventListener("metric", () => void load());
    source.addEventListener("quick_tunnel.ready", () => void load());
    source.addEventListener("quick_tunnel.stopped", () => void load());
    const interval = setInterval(() => void load(), 5000);
    return () => {
      source.close();
      clearInterval(interval);
    };
  }, [appId, load]);
  useEffect(() => {
    if (!logDeployment) return;
    let cancelled = false;
    let snapshotTimer: ReturnType<typeof setInterval> | null = null;
    setLogs("");
    setLogError("");
    setLogMode("stream");
    const scroll = () =>
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      });
    const loadSnapshot = async () => {
      try {
        const snapshot = await apiFetch<{ text: string }>(
          `/api/deployments/${logDeployment}/log-snapshot`,
        );
        if (cancelled) return;
        setLogs(snapshot.text);
        setLogError(
          "Live streaming is unavailable on this route. Logs are refreshing every two seconds.",
        );
        scroll();
      } catch (cause) {
        if (!cancelled) {
          setLogError(cause instanceof Error ? cause.message : "Could not refresh logs");
        }
      }
    };
    const startSnapshotPolling = () => {
      if (snapshotTimer) return;
      setLogMode("polling");
      void loadSnapshot();
      snapshotTimer = setInterval(() => void loadSnapshot(), 2000);
    };
    const source = new EventSource(`/api/deployments/${logDeployment}/logs`);
    source.addEventListener("log", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { stream: string; text: string };
      setLogs((current) => (current + payload.text).slice(-300000));
      setLogError("");
      scroll();
    });
    source.onerror = () => {
      source.close();
      startSnapshotPolling();
    };
    source.onopen = () => {
      setLogMode("stream");
      setLogError("");
    };
    return () => {
      cancelled = true;
      source.close();
      if (snapshotTimer) clearInterval(snapshotTimer);
    };
  }, [logDeployment]);
  function openLogs(deploymentId: string) {
    setLogDeployment(deploymentId);
    setActiveTab("logs");
  }
  async function action(name: "deploy" | "stop") {
    setBusy(name);
    setError("");
    try {
      await apiFetch(`/api/apps/${appId}/${name}`, {
        method: "POST",
        body: name === "deploy" ? "{}" : undefined,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${name} failed`);
    } finally {
      setBusy("");
    }
  }
  async function redeploy(commitSha: string | null) {
    if (!commitSha) return;
    setBusy(`redeploy-${commitSha}`);
    try {
      await apiFetch(`/api/apps/${appId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ commitSha }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Redeploy failed");
    } finally {
      setBusy("");
    }
  }
  async function promote(deploymentId: string) {
    setBusy(`promote-${deploymentId}`);
    setError("");
    try {
      await apiFetch(`/api/deployments/${deploymentId}/promote`, { method: "POST" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Promotion failed");
    } finally {
      setBusy("");
    }
  }
  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("settings");
    const form = new FormData(event.currentTarget);
    try {
      await apiFetch(`/api/apps/${appId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.get("name"),
          branch: form.get("branch"),
          flakeOutput: form.get("flakeOutput"),
          healthPath: form.get("healthPath"),
          restartPolicy: form.get("restartPolicy"),
          autoDeploy: form.get("autoDeploy") === "on",
        }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setBusy("");
    }
  }
  async function saveDomains(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("domains");
    setError("");
    const form = new FormData(event.currentTarget);
    const domains = String(form.get("domains") ?? "")
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      await apiFetch(`/api/apps/${appId}`, {
        method: "PATCH",
        body: JSON.stringify({ domains }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Domain synchronization failed");
    } finally {
      setBusy("");
    }
  }
  async function addEnv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("env");
    setError("");
    const element = event.currentTarget;
    const form = new FormData(element);
    try {
      await apiFetch(`/api/apps/${appId}/environment`, {
        method: "PUT",
        body: JSON.stringify({ dotenv: String(form.get("dotenv") ?? ""), secret: true }),
      });
      element.reset();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Environment update failed");
    } finally {
      setBusy("");
    }
  }
  async function removeEnv(key: string) {
    try {
      await apiFetch(`/api/apps/${appId}/environment`, {
        method: "DELETE",
        body: JSON.stringify({ key }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delete failed");
    }
  }
  async function removeApp() {
    if (
      !confirm(
        "Delete this application, deployment history, and local route? Persistent app data remains on disk for manual recovery.",
      )
    )
      return;
    setBusy("delete");
    try {
      await apiFetch(`/api/apps/${appId}`, { method: "DELETE" });
      router.replace("/apps");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delete failed");
      setBusy("");
    }
  }
  const selected = useMemo(
    () => data?.deployments.find((item) => item.id === logDeployment),
    [data, logDeployment],
  );
  if (!data)
    return (
      <div>
        {error ? (
          <div className="alert alert-error">{error}</div>
        ) : (
          <span className="loading loading-spinner loading-lg" />
        )}
      </div>
    );
  const app = data.app;
  const hasDeployment = data.deployments.length > 0;
  const isRunning = data.operationalStatus === "running";
  const deploymentInProgress = [
    "queued",
    "preparing",
    "fetching",
    "evaluating",
    "starting",
    "health-checking",
    "activating",
  ].includes(data.operationalStatus);
  return (
    <>
      <PageHeading
        title={app.name}
        description={app.repository_url}
        actions={
          <>
            <button
              type="button"
              disabled={!!busy || deploymentInProgress}
              className="btn btn-primary"
              onClick={() => void action("deploy")}
            >
              {busy === "deploy" || deploymentInProgress ? (
                <>
                  <span className="loading loading-spinner" /> Deploying…
                </>
              ) : hasDeployment ? (
                "Redeploy latest"
              ) : (
                "Deploy"
              )}
            </button>
            {isRunning && (
              <button
                type="button"
                disabled={!!busy}
                className="btn btn-ghost"
                onClick={() => void action("stop")}
              >
                Stop
              </button>
            )}
          </>
        }
      />
      {error && (
        <div className="alert alert-error mb-5">
          <span>{error}</span>
        </div>
      )}
      {data.deployments[0]?.state === "failed" && (
        <div className="alert alert-error mb-5">
          <div>
            <div className="font-bold">Latest deployment failed</div>
            <div>
              {data.deployments[0].failure_message || "Open deployment logs for details."}
              {data.deployments[0].resource_confidence !== "none"
                ? ` Resource-exhaustion confidence: ${data.deployments[0].resource_confidence}.`
                : ""}
            </div>
          </div>
        </div>
      )}
      {app.kind === "web" && (
        <div className="card mb-6 border border-base-300 bg-base-100">
          <div className="card-body">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="card-title">Access links</h2>
                <p className="text-sm text-base-content/60">Available application URLs.</p>
              </div>
            </div>
            <AccessLinks links={data.accessLinks} />
            <QuickTunnelNotice
              route={data.quickTunnel}
              activeMessage="This temporary URL is public. The application must provide its own authentication if access should be restricted."
            />
          </div>
        </div>
      )}
      <div className="metric-grid mb-6">
        <div className="stat rounded-box border border-base-300 bg-base-100">
          <div className="stat-title">Application status</div>
          <div className="stat-value text-xl">
            <StatusBadge state={data.operationalStatus} />
          </div>
        </div>
        <div className="stat rounded-box border border-base-300 bg-base-100">
          <div className="stat-title">Production branch</div>
          <div className="stat-value text-lg font-mono">{app.branch}</div>
          <div className="stat-desc">Auto deploy {app.auto_deploy ? "enabled" : "disabled"}</div>
        </div>
        <div className="stat rounded-box border border-base-300 bg-base-100">
          <div className="stat-title">Custom domains</div>
          <div className="stat-value text-xl">{data.domains.length}</div>
          <div className="stat-desc">
            {data.cloudflare.enabled
              ? `${data.cloudflare.routes.filter((route) => route.status === "managed").length} on Cloudflare`
              : data.cloudflare.configured
                ? "Named tunnel disabled"
                : "Cloudflare account optional"}
          </div>
        </div>
        <div className="stat rounded-box border border-base-300 bg-base-100">
          <div className="stat-title">Resource usage</div>
          <div className="stat-value text-lg">
            {data.metric ? `${data.metric.cpuPercent.toFixed(1)}% CPU` : "—"}
          </div>
          <div className="stat-desc">
            {data.metric
              ? `${formatBytes(data.metric.memoryBytes)} · ${data.metric.processCount} processes`
              : "No sample"}
          </div>
        </div>
      </div>

      <div role="tablist" className="tabs tabs-lifted overflow-x-auto">
        <input
          type="radio"
          name="app-tabs"
          role="tab"
          className="tab"
          aria-label="Deployments"
          checked={activeTab === "deployments"}
          onChange={() => setActiveTab("deployments")}
        />
        <div role="tabpanel" className="tab-content border-base-300 bg-base-100 p-5">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Revision</th>
                  <th>Trigger</th>
                  <th>Queued</th>
                  {app.kind === "web" && <th>Temporary deployment URL</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.deployments.map((deployment) => (
                  <tr key={deployment.id}>
                    <td>
                      <StatusBadge state={deployment.state} />
                      {deployment.isProduction && (
                        <span className="badge badge-primary badge-sm ml-2">Production</span>
                      )}
                    </td>
                    <td className="font-mono text-xs">
                      {(deployment.commit_sha || deployment.requested_ref).slice(0, 12)}
                    </td>
                    <td>{deployment.trigger}</td>
                    <td>{formatDate(deployment.queued_at)}</td>
                    {app.kind === "web" && (
                      <td className="min-w-64">
                        {deployment.quickTunnel?.url ? (
                          <AccessLinks
                            compact
                            links={[
                              {
                                kind: "temporary",
                                label: "Temporary",
                                url: deployment.quickTunnel.url,
                                status: deployment.quickTunnel.running ? "available" : "starting",
                                note: deployment.quickTunnel.lastError,
                              },
                            ]}
                          />
                        ) : deployment.state === "running" ? (
                          <QuickTunnelNotice
                            route={deployment.quickTunnel}
                            activeMessage="This temporary deployment URL is public."
                          />
                        ) : (
                          <span className="text-xs text-base-content/50">Not active</span>
                        )}
                      </td>
                    )}
                    <td>
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() => openLogs(deployment.id)}
                        >
                          Logs
                        </button>
                        {deployment.commit_sha && (
                          <button
                            type="button"
                            className="btn btn-xs btn-ghost"
                            disabled={!!busy}
                            onClick={() => void redeploy(deployment.commit_sha)}
                          >
                            Redeploy this revision
                          </button>
                        )}
                        {app.kind === "web" &&
                          deployment.state === "running" &&
                          !deployment.isProduction && (
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              disabled={!!busy || data.domains.length === 0}
                              title={
                                data.domains.length === 0
                                  ? "Configure a production domain before promoting"
                                  : `Promote to ${data.domains[0]}`
                              }
                              onClick={() => void promote(deployment.id)}
                            >
                              {busy === `promote-${deployment.id}` ? (
                                <span className="loading loading-spinner loading-xs" />
                              ) : (
                                "Promote to production"
                              )}
                            </button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {app.kind === "web" && data.domains.length === 0 && (
              <p className="mt-3 text-sm text-base-content/60">
                Configure a production domain on the Domains tab before promoting an active
                deployment. Temporary deployment URLs continue to work independently.
              </p>
            )}
          </div>
          {data.deployments.length === 0 && (
            <p className="text-base-content/60">No deployments yet.</p>
          )}
        </div>
        <input
          type="radio"
          name="app-tabs"
          role="tab"
          className="tab"
          aria-label="Logs"
          checked={activeTab === "logs"}
          onChange={() => setActiveTab("logs")}
        />
        <div role="tabpanel" className="tab-content border-base-300 bg-base-100 p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              {selected ? (
                <>
                  <StatusBadge state={selected.state} />{" "}
                  <span className="ml-2 font-mono text-xs">{selected.id.slice(0, 8)}</span>
                </>
              ) : (
                "Select a deployment"
              )}
            </div>
            <select
              className="select select-bordered select-sm"
              value={logDeployment ?? ""}
              onChange={(e) => setLogDeployment(e.target.value)}
            >
              {data.deployments.map((deployment) => (
                <option key={deployment.id} value={deployment.id}>
                  {deployment.state} ·{" "}
                  {(deployment.commit_sha || deployment.requested_ref).slice(0, 10)}
                </option>
              ))}
            </select>
          </div>
          <pre
            ref={logRef}
            className="h-[30rem] overflow-auto rounded-box bg-neutral p-4 text-xs text-neutral-content whitespace-pre-wrap"
          >
            {logs || "Connecting to deployment logs…"}
          </pre>
          {logError && <div className="alert alert-warning mt-4">{logError}</div>}
          <div className="mt-2 text-xs text-base-content/50">
            Log delivery: {logMode === "stream" ? "live stream" : "authenticated polling fallback"}
          </div>
          {selected && selected.resource_confidence !== "none" && (
            <div className="alert alert-warning mt-4">
              <span>Resource-exhaustion confidence: {selected.resource_confidence}</span>
            </div>
          )}
        </div>
        <input
          type="radio"
          name="app-tabs"
          role="tab"
          className="tab"
          aria-label="Environment"
          checked={activeTab === "environment"}
          onChange={() => setActiveTab("environment")}
        />
        <div role="tabpanel" className="tab-content border-base-300 bg-base-100 p-5">
          <div className="max-w-3xl">
            <h2 className="text-lg font-bold">Add or update environment secrets</h2>
            <p className="mt-1 text-sm text-base-content/65">
              Paste dotenv-style <code>KEY=value</code> lines. Existing keys with the same name are
              replaced; omitted keys are left unchanged. Values are encrypted and never shown again.
            </p>
            <div className="alert alert-warning mt-3 text-sm">
              Enter secrets through an HTTPS dashboard link or a trusted private LAN. Plain HTTP on
              a shared or untrusted network does not protect values in transit.
            </div>
            <form method="post" onSubmit={addEnv} className="mt-4 grid gap-3">
              <textarea
                required
                name="dotenv"
                className="textarea textarea-bordered min-h-48 font-mono"
                placeholder={`DATABASE_URL=postgres://...
API_TOKEN=...
# comments are ignored`}
                spellCheck={false}
                autoComplete="off"
                aria-label="Environment variables"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-base-content/55">
                  Up to 200 variables. Changes apply on the next start or deployment.
                </span>
                <button type="submit" disabled={busy === "env"} className="btn btn-primary">
                  {busy === "env" ? <span className="loading loading-spinner" /> : "Save secrets"}
                </button>
              </div>
            </form>
          </div>
          <div className="mt-5 divide-y divide-base-300 rounded-box border border-base-300">
            {data.environment.map((item) => (
              <div key={item.key} className="flex items-center justify-between p-3">
                <div>
                  <div className="font-mono font-medium">{item.key}</div>
                  <div className="text-xs text-base-content/55">
                    {item.secret ? "Encrypted secret" : "Encrypted value"} ·{" "}
                    {formatDate(item.updatedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void removeEnv(item.key)}
                >
                  Remove
                </button>
              </div>
            ))}
            {data.environment.length === 0 && (
              <div className="p-4 text-base-content/60">No application variables configured.</div>
            )}
          </div>
        </div>
        <input
          type="radio"
          name="app-tabs"
          role="tab"
          className="tab"
          aria-label="Domains"
          checked={activeTab === "domains"}
          onChange={() => setActiveTab("domains")}
        />
        <div role="tabpanel" className="tab-content border-base-300 bg-base-100 p-5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
            <div>
              <h2 className="text-lg font-bold">Application domains</h2>
              <p className="mt-1 text-sm text-base-content/65">
                Hostnames in a connected Cloudflare zone are created and routed by Nix Ship. The
                temporary public URL stays active when custom domains are added.
              </p>
              <form method="post" onSubmit={saveDomains} className="mt-4 grid gap-3">
                <textarea
                  name="domains"
                  defaultValue={data.domains.join("\n")}
                  className="textarea textarea-bordered min-h-32 font-mono"
                  aria-label="Custom domains"
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-base-content/55">
                    One hostname per line or comma-separated. Maximum 20.
                  </span>
                  <button type="submit" disabled={busy === "domains"} className="btn btn-primary">
                    {busy === "domains" ? (
                      <span className="loading loading-spinner" />
                    ) : (
                      "Save and sync domains"
                    )}
                  </button>
                </div>
              </form>
              <div className="mt-5 divide-y divide-base-300 rounded-box border border-base-300">
                {data.cloudflare.routes.map((route) => (
                  <div
                    key={route.hostname}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div>
                      <div className="font-mono font-medium">{route.hostname}</div>
                      <div className="mt-1 text-xs text-base-content/55">
                        Stable origin port {route.publicPort}
                        {route.lastSyncedAt ? ` · synced ${formatDate(route.lastSyncedAt)}` : ""}
                      </div>
                      {route.lastError && (
                        <div className="mt-1 text-xs text-error">{route.lastError}</div>
                      )}
                    </div>
                    <DomainRouteStatusBadge status={route.status} />
                  </div>
                ))}
                {data.domains.length === 0 && (
                  <div className="p-4 text-sm text-base-content/60">
                    No custom domains configured. Add one above to expose a memorable hostname.
                  </div>
                )}
              </div>
            </div>
            <aside className="rounded-box border border-base-300 bg-base-200/40 p-4">
              <h3 className="font-bold">Cloudflare connection</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt>Configured</dt>
                  <dd>{data.cloudflare.configured ? "Yes" : "No"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>Tunnel</dt>
                  <dd>
                    {data.cloudflare.enabled
                      ? data.cloudflare.running
                        ? "Running"
                        : "Starting"
                      : "Disabled"}
                  </dd>
                </div>
              </dl>
              <Link href="/integrations/cloudflare" className="btn btn-sm mt-4 w-full">
                Manage Cloudflare
              </Link>
              {!data.cloudflare.enabled && data.domains.length > 0 && (
                <div className="alert alert-warning mt-4 text-xs">
                  Cloudflare-managed hostnames will not be reachable through the tunnel until it is
                  enabled.
                </div>
              )}
            </aside>
          </div>
        </div>
        <input
          type="radio"
          name="app-tabs"
          role="tab"
          className="tab"
          aria-label="Settings"
          checked={activeTab === "settings"}
          onChange={() => setActiveTab("settings")}
        />
        <div role="tabpanel" className="tab-content border-base-300 bg-base-100 p-5">
          <form method="post" onSubmit={saveSettings} className="grid max-w-3xl gap-4">
            <label className="form-control">
              <span className="label-text mb-1">Name</span>
              <input name="name" defaultValue={app.name} className="input input-bordered" />
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="form-control">
                <span className="label-text mb-1">Branch</span>
                <input
                  name="branch"
                  defaultValue={app.branch}
                  className="input input-bordered font-mono"
                />
              </label>
              <label className="form-control">
                <span className="label-text mb-1">Flake app output</span>
                <input
                  name="flakeOutput"
                  defaultValue={app.flake_output}
                  className="input input-bordered font-mono"
                />
              </label>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="form-control">
                <span className="label-text mb-1">Health path</span>
                <input
                  name="healthPath"
                  defaultValue={app.health_path}
                  className="input input-bordered font-mono"
                />
              </label>
              <label className="form-control">
                <span className="label-text mb-1">Crash recovery policy</span>
                <select
                  name="restartPolicy"
                  defaultValue={
                    app.restart_policy === "always" ? "unless-stopped" : app.restart_policy
                  }
                  className="select select-bordered"
                >
                  <option value="on-failure">Restart only after unexpected failure</option>
                  <option value="unless-stopped">Keep running unless manually stopped</option>
                  <option value="never">Do not restart automatically</option>
                </select>
              </label>
            </div>
            <label className="label max-w-sm cursor-pointer">
              <span className="label-text">Automatically deploy production branch</span>
              <input
                name="autoDeploy"
                type="checkbox"
                defaultChecked={Boolean(app.auto_deploy)}
                className="toggle toggle-primary"
              />
            </label>
            <div>
              <button type="submit" disabled={busy === "settings"} className="btn btn-primary">
                Save settings
              </button>
            </div>
          </form>
          <div className="divider mt-10">Danger zone</div>
          <div className="flex items-center justify-between rounded-box border border-error/30 p-4">
            <div>
              <div className="font-bold">Delete application</div>
              <p className="text-sm text-base-content/60">
                Stops the process and removes Nix Ship metadata.
              </p>
            </div>
            <button
              type="button"
              disabled={busy === "delete"}
              className="btn btn-error btn-outline"
              onClick={() => void removeApp()}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
      <div className="mt-4">
        <Link className="link" href="/apps">
          ← All applications
        </Link>
      </div>
    </>
  );
}
