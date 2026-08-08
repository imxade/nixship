"use client";

import { type FormEvent, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { PageHeading } from "./page-heading";

export function AccountClient({
  username,
  role,
  initialError = "",
  initialMessage = "",
}: {
  username: string;
  role: string;
  initialError?: string;
  initialMessage?: string;
}) {
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState(initialMessage);
  const [busy, setBusy] = useState(false);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmation = String(data.get("confirmPassword") ?? "");
    setError("");
    setMessage("");
    if (newPassword !== confirmation) {
      setError("New password and confirmation do not match");
      return;
    }

    setBusy(true);
    try {
      await apiFetch("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: data.get("currentPassword"),
          newPassword,
          confirmPassword: confirmation,
        }),
      });
      form.reset();
      setMessage("Password changed. Other signed-in sessions were logged out.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Password change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        title="Account"
        description="Manage the credentials for your Nix Ship account."
      />
      <div className="grid max-w-4xl gap-5 lg:grid-cols-[18rem_1fr]">
        <section className="card h-fit border border-base-300 bg-base-100">
          <div className="card-body">
            <h2 className="card-title">Profile</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-base-content/60">Username</dt>
                <dd className="font-medium">{username}</dd>
              </div>
              <div>
                <dt className="text-base-content/60">Role</dt>
                <dd className="font-medium capitalize">{role}</dd>
              </div>
            </dl>
          </div>
        </section>
        <form
          action="/api/auth/password"
          method="post"
          onSubmit={changePassword}
          className="card border border-base-300 bg-base-100"
        >
          <div className="card-body">
            <h2 className="card-title">Change password</h2>
            <p className="text-sm text-base-content/65">
              Confirm your current password, then choose a new password with at least 12 characters.
            </p>
            {error && <div className="alert alert-error">{error}</div>}
            {message && <div className="alert alert-success">{message}</div>}
            <label className="form-control">
              <span className="label-text mb-1">Current password</span>
              <input
                name="currentPassword"
                required
                type="password"
                autoComplete="current-password"
                className="input input-bordered"
              />
            </label>
            <label className="form-control">
              <span className="label-text mb-1">New password</span>
              <input
                name="newPassword"
                required
                minLength={12}
                maxLength={256}
                type="password"
                autoComplete="new-password"
                className="input input-bordered"
              />
            </label>
            <label className="form-control">
              <span className="label-text mb-1">Confirm new password</span>
              <input
                name="confirmPassword"
                required
                minLength={12}
                maxLength={256}
                type="password"
                autoComplete="new-password"
                className="input input-bordered"
              />
            </label>
            <div className="card-actions justify-end">
              <button type="submit" disabled={busy} className="btn btn-primary">
                {busy ? <span className="loading loading-spinner" /> : "Change password"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </>
  );
}
