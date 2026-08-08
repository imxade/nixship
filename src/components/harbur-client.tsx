"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch, formatDate } from "@/lib/client-api";
import { PageHeading } from "./page-heading";

type Connection = {
  id: string;
  baseUrl: string;
  allowPrivateNetwork: boolean;
  privateAccess: boolean;
  eventCursor: number;
  status: "connected" | "error";
  lastError: string | null;
  updatedAt: string;
};

export function HarburClient() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await apiFetch<{ connections: Connection[] }>("/api/harbur/status");
      setConnections(result.connections);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Harbur connections");
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await apiFetch("/api/harbur/connect", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: form.get("baseUrl"),
          token: form.get("token"),
          allowPrivateNetwork: form.get("allowPrivateNetwork") === "on",
        }),
      });
      event.currentTarget.reset();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect Harbur");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(connectionId: string) {
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/harbur/disconnect", {
        method: "POST",
        body: JSON.stringify({ connectionId }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect Harbur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        title="Harbur"
        description="Import immutable repository snapshots and deploy new merge revisions automatically."
        actions={
          <a
            className="btn"
            href="https://github.com/imxade/harbur"
            target="_blank"
            rel="noreferrer"
          >
            Learn about Harbur
          </a>
        }
      />
      {error && <div className="alert alert-error mb-5">{error}</div>}
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="card border border-base-300 bg-base-100">
          <div className="card-body">
            <h2 className="card-title">Connect an instance</h2>
            <p className="text-sm text-base-content/65">
              Public-only access needs no token. For private repositories and automatic merge
              polling, use the token configured as <code>INTEGRATION_READ_TOKEN</code> on Harbur; it
              is encrypted at rest and never shown again.
            </p>
            <form className="mt-3 grid gap-4" onSubmit={connect}>
              <label className="form-control">
                <span className="label-text mb-1">Instance URL</span>
                <input
                  name="baseUrl"
                  type="url"
                  required
                  className="input input-bordered"
                  placeholder="https://code.example.com"
                />
              </label>
              <label className="form-control">
                <span className="label-text mb-1">
                  Read token (optional for public repositories)
                </span>
                <input
                  name="token"
                  type="password"
                  minLength={32}
                  className="input input-bordered"
                />
              </label>
              <label className="label cursor-pointer justify-start gap-3">
                <input name="allowPrivateNetwork" type="checkbox" className="checkbox" />
                <span className="label-text">
                  Allow this instance to resolve to LAN/private addresses
                </span>
              </label>
              <button type="submit" disabled={busy} className="btn btn-primary justify-self-start">
                {busy ? <span className="loading loading-spinner" /> : "Verify and connect"}
              </button>
            </form>
          </div>
        </section>
        <section className="card border border-base-300 bg-base-100">
          <div className="card-body">
            <h2 className="card-title">Connected instances</h2>
            {connections.length === 0 ? (
              <p className="text-base-content/60">No Harbur instance is connected.</p>
            ) : (
              <div className="grid gap-3">
                {connections.map((connection) => (
                  <article key={connection.id} className="rounded-box border border-base-300 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{connection.baseUrl}</div>
                        <div className="mt-1 text-xs text-base-content/55">
                          Cursor {connection.eventCursor} · checked{" "}
                          {formatDate(connection.updatedAt)}
                        </div>
                      </div>
                      <span
                        className={`badge ${connection.status === "connected" ? "badge-success" : "badge-error"}`}
                      >
                        {connection.status}
                      </span>
                    </div>
                    {connection.lastError && (
                      <div className="alert alert-error mt-3 text-sm">{connection.lastError}</div>
                    )}
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-xs text-base-content/55">
                        {connection.privateAccess
                          ? "Private repositories + merge polling"
                          : "Public repositories only"}
                        {connection.allowPrivateNetwork
                          ? " · private network allowed"
                          : " · public HTTPS only"}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        className="btn btn-error btn-outline btn-sm"
                        onClick={() => void disconnect(connection.id)}
                      >
                        Disconnect
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
