import crypto from "node:crypto";
import { getDb, nowIso, setSetting, setting } from "./db.ts";
import { registrableDomain } from "./domain-name.ts";
import { HttpError } from "./errors.ts";

export type DomainTargetType = "dashboard" | "application";
export type DomainAssignmentState =
  | "waiting-zone"
  | "provisioning"
  | "verifying"
  | "active"
  | "conflict"
  | "error"
  | "removing";

export interface DomainAssignmentRow {
  hostname: string;
  apex: string;
  target_type: DomainTargetType;
  app_id: string | null;
  state: DomainAssignmentState;
  zone_id: string | null;
  dns_record_id: string | null;
  tunnel_id: string | null;
  ownership_marker: string;
  last_error: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export function domainAssignment(hostname: string): DomainAssignmentRow | null {
  return (
    (getDb().prepare("SELECT * FROM domain_assignments WHERE hostname = ?").get(hostname) as
      | DomainAssignmentRow
      | undefined) ?? null
  );
}

export function replaceApplicationDomainAssignments(appId: string, hostnames: string[]): void {
  const desired = new Set(hostnames);
  const db = getDb();
  try {
    db.transaction(() => {
      for (const hostname of desired) claimDomain(hostname, "application", appId);

      db.prepare("DELETE FROM application_domains WHERE app_id = ?").run(appId);
      const insert = db.prepare(
        "INSERT INTO application_domains(hostname, app_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      const now = nowIso();
      for (const hostname of desired) insert.run(hostname, appId, now, now);

      const existing = db
        .prepare(
          `SELECT hostname, state, dns_record_id, tunnel_id
           FROM domain_assignments
           WHERE target_type = 'application' AND app_id = ?`,
        )
        .all(appId) as Array<{
        hostname: string;
        state: DomainAssignmentState;
        dns_record_id: string | null;
        tunnel_id: string | null;
      }>;
      const markForRemoval = db.prepare(
        `UPDATE domain_assignments
         SET state = 'removing', updated_at = ?
         WHERE hostname = ? AND target_type = 'application' AND app_id = ?`,
      );
      const releaseUnmanaged = db.prepare(
        "DELETE FROM domain_assignments WHERE hostname = ? AND target_type = 'application' AND app_id = ?",
      );
      for (const row of existing) {
        if (desired.has(row.hostname)) continue;
        if (row.state === "active" || row.dns_record_id || row.tunnel_id) {
          markForRemoval.run(nowIso(), row.hostname, appId);
        } else {
          releaseUnmanaged.run(row.hostname, appId);
        }
      }
    })();
  } catch (error) {
    throwDomainConflict(error);
  }
}

export function replaceDashboardDomainAssignment(
  previousHostname: string | null,
  nextHostname: string | null,
): void {
  if (previousHostname === nextHostname) return;
  const db = getDb();
  try {
    db.transaction(() => {
      if (previousHostname) {
        db.prepare(
          "DELETE FROM domain_assignments WHERE hostname = ? AND target_type = 'dashboard'",
        ).run(previousHostname);
      }
      if (nextHostname) claimDomain(nextHostname, "dashboard", null);
    })();
  } catch (error) {
    throwDomainConflict(error);
  }
}

export function updateDomainAssignment(
  hostname: string,
  input: {
    state?: DomainAssignmentState;
    zoneId?: string | null;
    dnsRecordId?: string | null;
    tunnelId?: string | null;
    lastError?: string | null;
    verifiedAt?: string | null;
  },
): void {
  const updates: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    updates.push(`${column} = ?`);
    values.push(value);
  };
  if (input.state !== undefined) add("state", input.state);
  if (input.zoneId !== undefined) add("zone_id", input.zoneId);
  if (input.dnsRecordId !== undefined) add("dns_record_id", input.dnsRecordId);
  if (input.tunnelId !== undefined) add("tunnel_id", input.tunnelId);
  if (input.lastError !== undefined) add("last_error", input.lastError);
  if (input.verifiedAt !== undefined) add("verified_at", input.verifiedAt);
  if (updates.length === 0) return;
  add("updated_at", nowIso());
  getDb()
    .prepare(`UPDATE domain_assignments SET ${updates.join(", ")} WHERE hostname = ?`)
    .run(...values, hostname);
}

export function domainOwnershipComment(hostname?: string): string {
  const assignment = hostname ? domainAssignment(hostname) : null;
  const marker = assignment?.ownership_marker;
  return `nixship:${domainInstanceId()}${marker ? `:${marker}` : ""}`;
}

export function ownsDomainComment(comment: string | null | undefined, hostname?: string): boolean {
  if (comment === domainOwnershipComment(hostname)) return true;
  const instanceId = domainInstanceId();
  const compactPrefix = `nixship:${instanceId}`;
  if (comment === compactPrefix) return true;
  if (comment?.startsWith(`${compactPrefix}:`)) return true;
  const legacyPrefix = `Managed by Nix Ship; instance=${instanceId}`;
  if (comment === legacyPrefix) return true;
  if (comment?.startsWith(`${legacyPrefix}; assignment=`)) return true;
  return comment === "Managed by Nix Ship";
}

function claimDomain(hostname: string, targetType: DomainTargetType, appId: string | null): void {
  const apex = registrableDomain(hostname);
  const existing = domainAssignment(hostname);
  if (existing) {
    if (existing.target_type === targetType && existing.app_id === appId) {
      if (existing.apex !== apex || existing.state === "removing") {
        getDb()
          .prepare(
            `UPDATE domain_assignments
             SET apex = ?,
               state = CASE WHEN state = 'removing' THEN 'waiting-zone' ELSE state END,
               last_error = CASE WHEN state = 'removing' THEN NULL ELSE last_error END,
               updated_at = ?
             WHERE hostname = ?`,
          )
          .run(apex, nowIso(), hostname);
      }
      return;
    }
    throw new HttpError(
      409,
      "The hostname is already assigned to another Nix Ship target",
      "domain_already_assigned",
    );
  }
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO domain_assignments(
        hostname, apex, target_type, app_id, state, ownership_marker, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'waiting-zone', ?, ?, ?)`,
    )
    .run(hostname, apex, targetType, appId, crypto.randomBytes(16).toString("hex"), now, now);
}

function throwDomainConflict(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    throw new HttpError(
      409,
      "The hostname is already assigned to another Nix Ship target",
      "domain_already_assigned",
    );
  }
  throw error;
}

function domainInstanceId(): string {
  const existing = setting("domain_instance_id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  setSetting("domain_instance_id", created);
  return created;
}
