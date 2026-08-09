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
  accountId: string | null;
  tunnelId: string | null;
  dashboardHostname: string | null;
  zones: DomainZone[];
  routes: DomainRoute[];
};

type DomainZone = {
  apex: string;
  zoneId: string;
  state: "discovered" | "pending-delegation" | "active" | "error";
  assignedNameservers: string[];
  observedNameservers: string[];
  originalNameservers: string[];
  observedRecords: Array<{
    type: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "CAA" | "DS";
    value: string;
  }>;
  originalRegistrar: string | null;
  inventoryConfirmed: boolean;
  activatedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export function CloudflareClient() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dashboardLinks, setDashboardLinks] = useState<AccessLink[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

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

  useEffect(() => {
    void load();
    const source = new EventSource("/api/events?scope=system");
    source.addEventListener("quick_tunnel.ready", () => void load());
    source.addEventListener("quick_tunnel.stopped", () => void load());
    const interval = setInterval(() => void load(), 5000);
    return () => {
      source.close();
      clearInterval(interval);
    };
  }, [load]);

  async function configureToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("token");
    const form = new FormData(event.currentTarget);
    try {
      setStatus(
        await apiFetch<Status>("/api/cloudflare/configure", {
          method: "POST",
          body: JSON.stringify({
            accountId: form.get("accountId"),
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

  async function confirmZone(apex: string) {
    setBusy(`zone:${apex}`);
    try {
      setStatus(
        await apiFetch<Status>(`/api/cloudflare/zones/${encodeURIComponent(apex)}/confirm`, {
          method: "POST",
        }),
      );
      await load();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Zone delegation check failed");
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
          onConfigure={configureToken}
          onSaveDashboard={saveDashboardHostname}
        />
      ) : (
        <div className="max-w-3xl">
          <section className="card border border-base-300 bg-base-100">
            <div className="card-body">
              <h2 className="card-title">Connect Cloudflare with an API token</h2>
              <p className="text-sm text-base-content/65">
                Create a restricted token once. Nix Ship encrypts it and uses it to discover zones,
                manage DNS records, and supervise the persistent tunnel.
              </p>
              <TokenConnectionForm busy={busy} onSubmit={configureToken} />
            </div>
          </section>
        </div>
      )}

      <ZoneOnboarding zones={status?.zones ?? []} busy={busy} onConfirm={confirmZone} />
      <DomainRoutes status={status} />
    </>
  );
}

function ZoneOnboarding({
  zones,
  busy,
  onConfirm,
}: {
  zones: DomainZone[];
  busy: string;
  onConfirm: (apex: string) => void;
}) {
  const pending = zones.filter((zone) => zone.state !== "active");
  if (pending.length === 0) return null;
  return (
    <section className="card mt-5 border border-warning/40 bg-base-100">
      <div className="card-body">
        <h2 className="card-title">Domain nameserver setup required</h2>
        <div className="grid gap-4">
          {pending.map((zone) => (
            <article key={zone.apex} className="rounded-box border border-base-300 p-4">
              <h3 className="font-semibold">{zone.apex}</h3>
              <p className="mt-1 text-sm text-base-content/70">
                Copy every DNS record from the current provider into Cloudflare before replacing
                nameservers{zone.originalRegistrar ? ` at ${zone.originalRegistrar}` : ""}. Missing
                mail, verification, or undiscovered subdomain records can cause an outage.
              </p>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[11rem_1fr]">
                <dt className="text-base-content/55">Cloudflare nameservers</dt>
                <dd className="space-y-1 font-mono">
                  {zone.assignedNameservers.map((nameserver) => (
                    <div key={nameserver}>{nameserver}</div>
                  ))}
                </dd>
                <dt className="text-base-content/55">Currently observed</dt>
                <dd className="break-words font-mono">
                  {zone.observedNameservers.join(", ") || "Not detected"}
                </dd>
              </dl>
              <div className="mt-3">
                <h4 className="text-sm font-medium">Publicly observable apex records</h4>
                {zone.observedRecords.length > 0 ? (
                  <div className="mt-2 overflow-x-auto">
                    <table className="table table-xs">
                      <tbody>
                        {zone.observedRecords.map((record) => (
                          <tr key={`${record.type}:${record.value}`}>
                            <th>{record.type}</th>
                            <td className="break-all font-mono">{record.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-base-content/60">
                    No common apex records detected.
                  </p>
                )}
                <p className="mt-2 text-xs text-base-content/60">
                  This is advisory only: public DNS cannot enumerate the zone or discover every
                  subdomain. Compare the complete record list in the current provider dashboard.
                </p>
              </div>
              <div className="alert alert-warning mt-3 text-sm">
                Disable an existing registrar DNSSEC DS record before changing nameservers.
                Re-enable DNSSEC through Cloudflare only after the zone is active.
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm mt-3"
                disabled={!!busy}
                onClick={() => onConfirm(zone.apex)}
              >
                {busy === `zone:${zone.apex}` && <span className="loading loading-spinner" />}
                {zone.inventoryConfirmed ? "Check delegation" : "I copied every DNS record"}
              </button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function TokenConnectionForm({
  busy,
  onSubmit,
  accountId,
  dashboardHostname,
}: {
  busy: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  accountId?: string | null;
  dashboardHostname?: string | null;
}) {
  return (
    <form method="post" onSubmit={onSubmit} className="mt-3 grid gap-3">
      <label className="form-control">
        <span className="label-text mb-1">Cloudflare account ID</span>
        <input
          required
          name="accountId"
          defaultValue={accountId ?? ""}
          className="input input-bordered font-mono"
        />
      </label>
      <div className="rounded-box border border-base-300 bg-base-200/50 p-4 text-sm">
        <h3 className="font-semibold text-base-content">Create a restricted API token in Cloudflare</h3>
        <p className="mt-1 text-xs text-base-content/70">
          Go to your Cloudflare Dashboard under <strong>Profile &gt; API Tokens</strong> and create a custom token with these permissions:
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="table table-xs">
            <thead>
              <tr className="text-base-content/60">
                <th>Resource</th>
                <th>Permission</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              <tr>
                <td>Account</td>
                <td>Cloudflare Tunnel / Connector</td>
                <td>Edit</td>
              </tr>
              <tr>
                <td>Zone</td>
                <td>Zone</td>
                <td>Read</td>
              </tr>
              <tr>
                <td>Zone</td>
                <td>Zone</td>
                <td>Edit</td>
              </tr>
              <tr>
                <td>Zone</td>
                <td>DNS</td>
                <td>Edit</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-base-content/60">
          Restrict the Account permission to your specific account. Zone permissions must cover all zones in that account. Global API keys and OAuth are not supported.
        </p>
      </div>
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
          defaultValue={dashboardHostname ?? ""}
          placeholder="console.example.com"
          className="input input-bordered"
        />
      </label>
      <button
        type="submit"
        disabled={busy === "token"}
        className="btn btn-primary w-full sm:w-auto"
      >
        {busy === "token" && <span className="loading loading-spinner" />}
        Connect Cloudflare
      </button>
    </form>
  );
}

function ConfiguredConnection({
  status,
  busy,
  onConfigure,
  onSaveDashboard,
}: {
  status: Status;
  busy: string;
  onConfigure: (event: FormEvent<HTMLFormElement>) => void;
  onSaveDashboard: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="card border border-base-300 bg-base-100">
        <div className="card-body">
          <h2 className="card-title">Persistent tunnel</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-base-content/55">Authorization</dt>
            <dd>Restricted API token</dd>
            <dt className="text-base-content/55">Account</dt>
            <dd className="break-all font-mono">{status.accountId}</dd>
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
          <details className="collapse collapse-arrow mt-2 border border-base-300">
            <summary className="collapse-title text-sm font-medium">Replace API token</summary>
            <div className="collapse-content">
              <TokenConnectionForm
                busy={busy}
                onSubmit={onConfigure}
                accountId={status.accountId}
                dashboardHostname={status.dashboardHostname}
              />
            </div>
          </details>
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
              Project hostnames in active Cloudflare zones are synchronized automatically. Pending
              hostnames wait for zone activation while the stable LAN origin remains available.
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
