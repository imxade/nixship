"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { apiFetch } from "@/lib/client-api";

export function SetupForm({
  authorized,
  initialError = "",
}: {
  authorized: boolean;
  initialError?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await apiFetch("/api/setup/complete", {
        method: "POST",
        body: JSON.stringify({
          username: data.get("username"),
          password: data.get("password"),
        }),
      });
      router.replace("/apps");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      action="/api/setup/complete"
      method="post"
      onSubmit={submit}
      className="card-body gap-5 px-6 py-7 sm:px-8 sm:py-8"
    >
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Claim this Nix Ship</h1>
        <p className="text-base-content/70 mt-2">
          {authorized
            ? "Create the owner account for this device."
            : "Open one of the first-run setup links printed by the Nix Ship process."}
        </p>
      </div>
      {error && (
        <div className="alert alert-error">
          <span>{error}</span>
        </div>
      )}
      {authorized ? (
        <>
          <label className="form-control">
            <span className="label-text mb-1">Owner username</span>
            <input
              name="username"
              required
              minLength={3}
              autoComplete="username"
              className="input input-bordered"
            />
          </label>
          <label className="form-control">
            <span className="label-text mb-1">Password</span>
            <input
              name="password"
              required
              minLength={12}
              type="password"
              autoComplete="new-password"
              className="input input-bordered"
            />
            <span className="label-text-alt">Use at least 12 characters.</span>
          </label>
          <button type="submit" disabled={busy} className="btn btn-primary">
            {busy ? <span className="loading loading-spinner" /> : "Create owner account"}
          </button>
        </>
      ) : (
        <div className="alert alert-info">
          <span>
            The link contains the one-time claim credential. If it expired or was opened on another
            device, open the link again from that device.
          </span>
        </div>
      )}
    </form>
  );
}
