"use client";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch, formatDate } from "@/lib/client-api";
import { type AccessLink, AccessLinks } from "./access-links";
import { type DomainRoute, DomainRouteStatusBadge } from "./domain-route-status";
import { PageHeading } from "./page-heading";

type Status = {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  connectionMethod: "api_token" | "oauth" | null;
  accountId: string | null;
  zoneId: string | null;
  tunnelId: string | null;
  dashboardHostname: string | null;
  oauth: { available: boolean; pending: boolean };
  routes: DomainRoute[];
};

type OAuthResources = {
  accounts: Array<{ id: string; name: string }>;
  zones: Array<{ id: string; name: string; accountId: string; accountName: string }>;
};

export function CloudflareClient() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dashboardLinks, setDashboardLinks] = useState<AccessLink[]>([]);
  const [resources, setResources] = useState<OAuthResources | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [manualOpen, setManualOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [next, system] = await Promise.all([
        apiFetch<Status>("/api/cloudflare/status"),
        apiFetch<{ accessLinks: AccessLink[] }>("/api/system/status"),
      ]);
      setStatus(next);
      setDashboardLinks(system.accessLinks);
      setError("");
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Load failed");
      return null;
    }
  }, []);

  const loadOAuthResources = useCallback(async () => {
    setBusy("oauth-options");
    try {
      setResources(await apiFetch<OAuthResources>("/api/cloudflare/oauth/options"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cloudflare account discovery failed");
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    void load();
    const query = new URLSearchParams(window.location.search);
    const callbackError = query.get("error");
    if (callbackError) setError(callbackError);
    if (query.has("error") || query.has("authorization")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    const source = new EventSource("/api/events?scope=system");
    source.addEventListener("quick_tunnel.ready", () => void load());
    source.addEventListener("quick_tunnel.stopped", () => void load());
    const interval = setInterval(() => void load(), 5000);
    return () => {
      source.close();
      clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    if (status?.oauth.pending && !resources && busy !== "oauth-options") {
      void loadOAuthResources();
    }
  }, [busy, loadOAuthResources, resources, status?.oauth.pending]);

  async function connectOAuth() {
    setBusy("oauth");
    try {
      const result = await apiFetch<{ authorizationUrl: string }>("/api/cloudflare/oauth/start", {
        method: "POST",
      });
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cloudflare authorization failed");
      setBusy("");
    }
  }

  async function completeOAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("oauth-complete");
    const form = new FormData(event.currentTarget);
    const [accountId, zoneId] = String(form.get("zone") ?? "").split(":");
    try {
      setStatus(
        await apiFetch<Status>("/api/cloudflare/oauth/complete", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            zoneId,
            tunnelName: form.get("tunnelName"),
            dashboardHostname: form.get("dashboardHostname"),
          }),
        }),
      );
      setResources(null);
      await load();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cloudflare connection failed");
    } finally {
      setBusy("");
    }
  }

  async function configureManually(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("manual");
    const form = new FormData(event.currentTarget);
    try {
      setStatus(
        await apiFetch<Status>("/api/cloudflare/configure", {
          method: "POST",
          body: JSON.stringify({
            accountId: form.get("accountId"),
            zoneId: form.get("zoneId"),
            apiToken: form.get("apiToken"),
            tunnelName: form.get("tunnelName"),
            dashboardHostname: form.get("dashboardHostname"),
          }),
        }),
      );
      await load();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Configuration failed");
    } finally {
      setBusy("");
    }
  }

  async function saveDashboardHostname(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("dashboard");
    const form = new FormData(event.currentTarget);
    try {
      setStatus(
        await apiFetch<Status>("/api/cloudflare/dashboard", {
          method: "PUT",
          body: JSON.stringify({ hostname: form.get("hostname") }),
        }),
      );
      await load();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dashboard domain update failed");
    } finally {
      setBusy("");
    }
  }

  async function toggleNamedTunnel() {
    setBusy("toggle");
    try {
      setStatus(
        await apiFetch<Status>(`/api/cloudflare/${status?.enabled ? "disable" : "enable"}`, {
          method: "POST",
        }),
      );
      await load();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tunnel action failed");
    } finally {
      setBusy("");
    }
  }

  const routeNeedsAttention =
    status?.routes.some((route) => route.status === "pending" || route.status === "error") ?? false;

  async function sync() {
    setBusy("sync");
    try {
      setStatus(await apiFetch<Status>("/api/cloudflare/sync", { method: "POST" }));
      await load();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Route sync failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <PageHeading
        title="Cloudflare"
        description="Connect once, then Nix Ship creates and supervises the tunnel, DNS records, and application routes."
        actions={
          status?.configured ? (
            <>
              {routeNeedsAttention && (
                <button type="button" disabled={!!busy} className="btn" onClick={() => void sync()}>
                  Retry route sync
                </button>
              )}
              <button
                type="button"
                disabled={!!busy}
                className={`btn ${status.enabled ? "btn-warning" : "btn-primary"}`}
                onClick={() => void toggleNamedTunnel()}
              >
                {status.enabled ? "Disable tunnel" : "Enable tunnel"}
              </button>
            </>
          ) : undefined
        }
      />

      {error && (
        <div className="alert alert-error mb-5 break-words">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {status && (
        <section className="card mb-5 border border-base-300 bg-base-100">
          <div className="card-body">
            <h2 className="card-title">Dashboard access links</h2>
            <p className="text-sm text-base-content/65">
              Quick Tunnel access works without Cloudflare authentication. Connecting an account
              adds a persistent custom hostname without disabling the temporary URL.
            </p>
            <AccessLinks links={dashboardLinks} />
          </div>
        </section>
      )}

      {!status ? (
        !error && (
          <div className="grid min-h-48 place-items-center">
            <span className="loading loading-spinner loading-lg" />
          </div>
        )
      ) : status.configured ? (
        <ConfiguredConnection
          status={status}
          busy={busy}
          onReconnect={() => void connectOAuth()}
          onSaveDashboard={saveDashboardHostname}
        />
      ) : (
        <div className="max-w-3xl">
          <section className="card border border-base-300 bg-base-100">
            <div className="card-body">
              <h2 className="card-title">Connect your Cloudflare account</h2>
              <p className="text-sm text-base-content/65">
                Authorize Nix Ship, choose an existing Cloudflare DNS zone, and the persistent
                tunnel starts automatically.
              </p>
              {status.oauth.pending ? (
                <OAuthCompletionForm
                  resources={resources}
                  busy={busy}
                  onSubmit={completeOAuth}
                  onRetry={() => void loadOAuthResources()}
                />
              ) : status.oauth.available ? (
                <button
                  type="button"
                  className="btn btn-primary mt-2 w-full sm:w-auto"
                  disabled={!!busy}
                  onClick={() => void connectOAuth()}
                >
                  {busy === "oauth" && <span className="loading loading-spinner" />}
                  Connect Cloudflare
                </button>
              ) : (
                <div className="alert alert-warning mt-2">
                  <span>
                    Cloudflare OAuth is disabled or not fully configured in this distribution.
                    Manual token connection and automatic Quick Tunnels remain available.
                  </span>
                </div>
              )}
              <details
                className="collapse collapse-arrow mt-3 border border-base-300"
                onToggle={(event) => setManualOpen(event.currentTarget.open)}
              >
                <summary className="collapse-title font-medium">Manual API token fallback</summary>
                {manualOpen && (
                  <div className="collapse-content">
                    <ManualConnectionForm busy={busy} onSubmit={configureManually} />
                  </div>
                )}
              </details>
            </div>
          </section>
        </div>
      )}

      <DomainRoutes status={status} />
    </>
  );
}

function OAuthCompletionForm({
  resources,
  busy,
  onSubmit,
  onRetry,
}: {
  resources: OAuthResources | null;
  busy: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRetry: () => void;
}) {
  if (!resources || busy === "oauth-options") {
    return (
      <div className="grid min-h-28 place-items-center">
        <span className="loading loading-spinner" />
      </div>
    );
  }
  if (resources.zones.length === 0) {
    return (
      <div className="alert alert-warning mt-3">
        <span>
          No active Cloudflare DNS zone is available. Add a domain to the authorized account, then
          retry discovery.
        </span>
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <form method="post" onSubmit={onSubmit} className="mt-3 grid gap-4">
      <label className="form-control">
        <span className="label-text mb-1">Cloudflare zone</span>
        <select name="zone" required className="select select-bordered w-full">
          {resources.zones.map((zone) => (
            <option key={zone.id} value={`${zone.accountId}:${zone.id}`}>
              {zone.accountName} · {zone.name}
            </option>
          ))}
        </select>
      </label>
      <label className="form-control">
        <span className="label-text mb-1">Tunnel name</span>
        <input required name="tunnelName" defaultValue="nixship" className="input input-bordered" />
      </label>
      <label className="form-control">
        <span className="label-text mb-1">Dashboard hostname (optional)</span>
        <input
          name="dashboardHostname"
          placeholder="console.example.com"
          className="input input-bordered"
        />
      </label>
      <button
        type="submit"
        disabled={busy === "oauth-complete"}
        className="btn btn-primary w-full sm:w-auto"
      >
        {busy === "oauth-complete" && <span className="loading loading-spinner" />}
        Create and enable tunnel
      </button>
    </form>
  );
}

function ManualConnectionForm({
  busy,
  onSubmit,
}: {
  busy: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form method="post" onSubmit={onSubmit} className="grid gap-3">
      <p className="text-sm text-base-content/65">
        Use a token restricted to Tunnel edit, Zone read, and DNS edit.
      </p>
      <label className="form-control">
        <span className="label-text mb-1">Account ID</span>
        <input required name="accountId" className="input input-bordered font-mono" />
      </label>
      <label className="form-control">
        <span className="label-text mb-1">Zone ID</span>
        <input required name="zoneId" className="input input-bordered font-mono" />
      </label>
      <label className="form-control">
        <span className="label-text mb-1">API token</span>
        <input required name="apiToken" type="password" className="input input-bordered" />
      </label>
      <label className="form-control">
        <span className="label-text mb-1">Tunnel name</span>
        <input required name="tunnelName" defaultValue="nixship" className="input input-bordered" />
      </label>
      <label className="form-control">
        <span className="label-text mb-1">Dashboard hostname (optional)</span>
        <input
          name="dashboardHostname"
          placeholder="console.example.com"
          className="input input-bordered"
        />
      </label>
      <button type="submit" disabled={busy === "manual"} className="btn w-full sm:w-auto">
        {busy === "manual" && <span className="loading loading-spinner" />}
        Save manual connection
      </button>
    </form>
  );
}

function ConfiguredConnection({
  status,
  busy,
  onReconnect,
  onSaveDashboard,
}: {
  status: Status;
  busy: string;
  onReconnect: () => void;
  onSaveDashboard: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="card border border-base-300 bg-base-100">
        <div className="card-body">
          <h2 className="card-title">Persistent tunnel</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-base-content/55">Authorization</dt>
            <dd>{status.connectionMethod === "oauth" ? "Cloudflare OAuth" : "Manual API token"}</dd>
            <dt className="text-base-content/55">Account</dt>
            <dd className="break-all font-mono">{status.accountId}</dd>
            <dt className="text-base-content/55">Zone</dt>
            <dd className="break-all font-mono">{status.zoneId}</dd>
            <dt className="text-base-content/55">Tunnel</dt>
            <dd className="break-all font-mono">{status.tunnelId || "Creating…"}</dd>
            <dt className="text-base-content/55">State</dt>
            <dd>
              <span
                className={`badge ${
                  status.running
                    ? "badge-success"
                    : status.enabled
                      ? "badge-warning"
                      : "badge-ghost"
                }`}
              >
                {status.running ? "Running" : status.enabled ? "Reconnecting" : "Disabled"}
              </span>
            </dd>
          </dl>
          {status.oauth.available && (
            <button
              type="button"
              className="btn btn-sm mt-2 w-full sm:w-auto"
              disabled={!!busy}
              onClick={onReconnect}
            >
              Reauthorize Cloudflare
            </button>
          )}
        </div>
      </section>

      <form
        method="post"
        onSubmit={onSaveDashboard}
        className="card border border-base-300 bg-base-100"
        key={status.dashboardHostname ?? "dashboard-domain"}
      >
        <div className="card-body">
          <h2 className="card-title">Dashboard domain</h2>
          <p className="text-sm text-base-content/65">
            Add or replace the dashboard hostname without re-entering Cloudflare credentials.
          </p>
          <label className="form-control">
            <span className="label-text mb-1">Hostname</span>
            <input
              name="hostname"
              defaultValue={status.dashboardHostname ?? ""}
              placeholder="console.example.com"
              className="input input-bordered"
            />
          </label>
          <button
            type="submit"
            disabled={busy === "dashboard"}
            className="btn btn-primary w-full sm:w-auto"
          >
            {busy === "dashboard" && <span className="loading loading-spinner" />}
            Save and sync dashboard
          </button>
          <div className="alert alert-warning text-sm">
            <span>
              Protect the public dashboard with Cloudflare Access in addition to Nix Ship login.
            </span>
          </div>
        </div>
      </form>
    </div>
  );
}

function DomainRoutes({ status }: { status: Status | null }) {
  return (
    <section className="card mt-5 border border-base-300 bg-base-100">
      <div className="card-body">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="card-title">Application domain routes</h2>
            <p className="mt-1 text-sm text-base-content/65">
              Project hostnames in authorized zones are synchronized automatically. Other providers
              continue using each application’s stable LAN origin.
            </p>
          </div>
          <Link href="/apps" className="btn btn-sm">
            Manage applications
          </Link>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Hostname</th>
                <th>Route state</th>
                <th>Stable origin</th>
                <th>Last sync</th>
              </tr>
            </thead>
            <tbody>
              {status?.routes.map((route) => (
                <tr key={route.hostname}>
                  <td>
                    <Link href={`/apps/${route.appId}`} className="link font-medium">
                      {route.appName}
                    </Link>
                  </td>
                  <td className="font-mono">{route.hostname}</td>
                  <td>
                    <DomainRouteStatusBadge status={route.status} />
                    {route.lastError && (
                      <div className="mt-1 max-w-md text-xs text-error">{route.lastError}</div>
                    )}
                  </td>
                  <td className="font-mono">127.0.0.1:{route.publicPort}</td>
                  <td>{route.lastSyncedAt ? formatDate(route.lastSyncedAt) : "Not synced"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {status && status.routes.length === 0 && (
          <div className="rounded-box border border-dashed border-base-300 p-5 text-sm text-base-content/65">
            No application domains are configured. Open an application, select Domains, add its
            hostnames, and save.
          </div>
        )}
      </div>
    </section>
  );
}
