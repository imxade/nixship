"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiFetch, formatDate } from "@/lib/client-api";
import { PageHeading } from "./page-heading";

type User = {
  id: string;
  username: string;
  role: string;
  disabled: number;
  created_at: string;
  updated_at: string;
};
export function UsersClient() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const load = useCallback(async () => {
    try {
      setUsers(await apiFetch<User[]>("/api/users"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const element = e.currentTarget;
    const f = new FormData(element);
    try {
      await apiFetch("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: f.get("username"),
          password: f.get("password"),
          role: f.get("role"),
          currentPassword,
        }),
      });
      element.reset();
      setCurrentPassword("");
      await load();
    } catch (c) {
      setError(c instanceof Error ? c.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }
  async function toggle(user: User) {
    if (!currentPassword) {
      setError("Enter your current password before changing a user.");
      return;
    }
    try {
      await apiFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: !user.disabled, currentPassword }),
      });
      setCurrentPassword("");
      await load();
    } catch (c) {
      setError(c instanceof Error ? c.message : "Update failed");
    }
  }
  return (
    <>
      <PageHeading
        title="Users"
        description="Create role-scoped accounts for people who can access this host over the LAN or through an explicitly exposed tunnel."
      />
      {error && <div className="alert alert-error mb-5">{error}</div>}
      <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
        <div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Created</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td className="font-medium">{user.username}</td>
                  <td>
                    <span className="badge badge-outline">{user.role}</span>
                  </td>
                  <td>{formatDate(user.created_at)}</td>
                  <td>
                    <span className={`badge ${user.disabled ? "badge-error" : "badge-success"}`}>
                      {user.disabled ? "disabled" : "active"}
                    </span>
                  </td>
                  <td>
                    {user.role !== "owner" && (
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() => void toggle(user)}
                      >
                        {user.disabled ? "Enable" : "Disable"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form
          method="post"
          onSubmit={create}
          className="card h-fit border border-base-300 bg-base-100"
        >
          <div className="card-body">
            <h2 className="card-title">Add user</h2>
            <label className="form-control">
              <span className="label-text mb-1">Your current password</span>
              <input
                required
                name="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                autoComplete="current-password"
                className="input input-bordered"
              />
            </label>
            <label className="form-control">
              <span className="label-text mb-1">Username</span>
              <input name="username" required minLength={3} className="input input-bordered" />
            </label>
            <label className="form-control">
              <span className="label-text mb-1">Temporary password</span>
              <input
                name="password"
                required
                minLength={12}
                type="password"
                className="input input-bordered"
              />
            </label>
            <label className="form-control">
              <span className="label-text mb-1">Role</span>
              <select name="role" className="select select-bordered">
                <option value="operator">Operator</option>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button type="submit" disabled={busy} className="btn btn-primary">
              Create user
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
