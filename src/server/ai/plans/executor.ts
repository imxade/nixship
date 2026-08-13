import crypto from "node:crypto";
import { audit } from "../../audit.ts";
import type { AuthenticatedActor } from "../../auth.ts";
import { sha256 } from "../../crypto.ts";
import { getDb, nowIso } from "../../db.ts";
import { errorMessage, HttpError } from "../../errors.ts";
import { events } from "../../events.ts";
import { assertCapabilityRole, type CapabilityRegistry } from "../capabilities/registry.ts";
import type { CapabilityContext } from "../capabilities/types.ts";
import { assertFreshAiReauth } from "../reauth.ts";
import type { ActionPlan, PlanStateSnapshot } from "./schema.ts";
import { getPlan } from "./store.ts";

export interface AiRunRecord {
  id: string;
  planId: string;
  status: string;
  errorCode: string | null;
  errorSummary: string | null;
  steps: Array<{
    planStepId: string;
    capabilityId: string;
    status: string;
    result: unknown;
    errorCode: string | null;
    errorSummary: string | null;
  }>;
}

export async function approveAndExecutePlan(input: {
  planId: string;
  planHash: string;
  actor: AuthenticatedActor;
  requestId: string;
  destructiveConfirmation?: string;
  registry: CapabilityRegistry;
  background?: boolean;
}): Promise<AiRunRecord> {
  const actor = refreshActor(input.actor);
  const current = getPlan(input.planId, actor);
  if (current.planHash !== input.planHash) {
    throw new HttpError(409, "Plan hash does not match", "plan_hash_mismatch");
  }
  if (current.createdBy !== actor.id) {
    throw new HttpError(403, "Only the requesting user may approve this plan", "wrong_plan_actor");
  }
  const existingRun = latestRun(current.id);
  if (current.status !== "proposed") {
    if (existingRun && ["approved", "queued", "running", "succeeded"].includes(current.status)) {
      return getRun(existingRun.id, actor);
    }
    throw new HttpError(409, "Plan is no longer awaiting approval", "invalid_plan_state");
  }
  if (current.risk === "sensitive" || current.risk === "destructive") {
    assertFreshAiReauth(actor);
  }
  if (
    current.risk === "destructive" &&
    input.destructiveConfirmation !== destructiveConfirmationText(current.id)
  ) {
    throw new HttpError(
      400,
      "Type the exact destructive confirmation shown on the plan",
      "destructive_confirmation_required",
    );
  }
  if (Date.parse(current.expiresAt) <= Date.now()) {
    getDb()
      .prepare("UPDATE ai_plans SET status = 'expired', updated_at = ? WHERE id = ?")
      .run(nowIso(), current.id);
    throw new HttpError(409, "Plan has expired", "plan_expired");
  }

  const ctx: CapabilityContext = { actor, requestId: input.requestId };
  await checkPlanPreconditions(current.id, current.plan, current.snapshot, ctx, input.registry);
  const runId = crypto.randomUUID();
  const now = nowIso();
  const inserted = getDb().transaction(() => {
    const changed = getDb()
      .prepare(
        `UPDATE ai_plans SET status = 'approved', approved_by = ?, approved_session_id = ?,
          approved_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed' AND plan_hash = ?`,
      )
      .run(actor.id, actor.sessionId, now, now, current.id, current.planHash).changes;
    if (changed !== 1) return false;
    getDb()
      .prepare(
        "INSERT INTO ai_plan_runs(id, plan_id, status, created_at) VALUES (?, ?, 'queued', ?)",
      )
      .run(runId, current.id, now);
    for (const step of current.plan.steps) {
      getDb()
        .prepare(
          `INSERT INTO ai_plan_run_steps(
            id, run_id, plan_step_id, capability_id, capability_version, status, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          crypto.randomUUID(),
          runId,
          step.id,
          step.capabilityId,
          step.capabilityVersion,
          stepIdempotencyKey(current.id, step.id, step.capabilityId, step.capabilityVersion),
        );
    }
    return true;
  })();
  if (!inserted) {
    const concurrent = latestRun(current.id);
    if (concurrent) return getRun(concurrent.id, actor);
    throw new HttpError(409, "Plan approval raced with another request", "approval_conflict");
  }
  audit({
    userId: actor.id,
    action: "ai.plan_approved",
    entityType: "ai_plan",
    entityId: current.id,
    details: { planHash: current.planHash, runId },
  });
  if (input.background) {
    void executeRun(runId, current.plan, current.snapshot, ctx, input.registry).catch(() => {
      // executeRun persists and publishes a sanitized failure before rejecting.
    });
    return getRun(runId, actor);
  }
  await executeRun(runId, current.plan, current.snapshot, ctx, input.registry);
  return getRun(runId, actor);
}

export function destructiveConfirmationText(planId: string): string {
  return `DELETE ${planId}`;
}

async function executeRun(
  runId: string,
  plan: ActionPlan,
  snapshot: PlanStateSnapshot,
  ctx: CapabilityContext,
  registry: CapabilityRegistry,
): Promise<void> {
  const resourceKeys = [...new Set(plan.steps.flatMap((step) => step.resourceKeys))].sort();
  let locksAcquired = false;
  let lockRenewalTimer: NodeJS.Timeout | null = null;
  try {
    acquireLocks(runId, resourceKeys);
    locksAcquired = true;
    lockRenewalTimer = setInterval(() => renewLocks(runId), 60_000);
    lockRenewalTimer.unref();
    setRunState(runId, "running");
    events.publish("ai.run.started", `ai-run:${runId}`, { runId });
    for (const step of plan.steps) {
      ctx.actor = refreshActor(ctx.actor);
      const capability = registry.get(step.capabilityId);
      assertCapabilityRole(ctx.actor.role, capability.requiredRoles);
      if (capability.version !== step.capabilityVersion) {
        throw new HttpError(409, "Capability version changed", "capability_version");
      }
      const parsedInput = capability.inputSchema.parse(step.input);
      const expected = snapshot.steps[step.id];
      const condition = await capability.preconditions(
        ctx,
        parsedInput,
        expected?.stateVersion ?? null,
      );
      if (!condition.ok) {
        throw new HttpError(
          409,
          condition.message ?? "Plan state is stale",
          condition.code ?? "stale_plan",
        );
      }
      setStepState(runId, step.id, "running");
      events.publish("ai.run.step", `ai-run:${runId}`, {
        runId,
        stepId: step.id,
        status: "running",
      });
      const key = stepIdempotencyKey(
        planIdForRun(runId),
        step.id,
        step.capabilityId,
        step.capabilityVersion,
      );
      const output = capability.outputSchema.parse(
        await capability.execute(ctx, parsedInput, {
          planId: planIdForRun(runId),
          runId,
          stepId: step.id,
          idempotencyKey: key,
        }),
      );
      const verification = capability.verify
        ? await capability.verify(ctx, parsedInput, output)
        : { ok: true, message: "Capability completed." };
      if (!verification.ok) throw new HttpError(500, verification.message, "verification_failed");
      getDb()
        .prepare(
          `UPDATE ai_plan_run_steps SET status = 'succeeded', result_json = ?, finished_at = ?
           WHERE run_id = ? AND plan_step_id = ?`,
        )
        .run(JSON.stringify(output), nowIso(), runId, step.id);
      events.publish("ai.run.step", `ai-run:${runId}`, {
        runId,
        stepId: step.id,
        status: "succeeded",
      });
      audit({
        userId: ctx.actor.id,
        action: "ai.capability_executed",
        entityType: "ai_plan_run",
        entityId: runId,
        details: {
          capabilityId: capability.id,
          capabilityVersion: capability.version,
          stepId: step.id,
        },
      });
    }
    finishRun(runId, "succeeded", null, null);
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "execution_failed";
    const summary = error instanceof HttpError ? error.message : "Plan execution failed";
    const runningStep = getDb()
      .prepare("SELECT plan_step_id FROM ai_plan_run_steps WHERE run_id = ? AND status = 'running'")
      .get(runId) as { plan_step_id: string } | undefined;
    if (runningStep) {
      getDb()
        .prepare(
          `UPDATE ai_plan_run_steps SET status = 'failed', error_code = ?, error_summary = ?, finished_at = ?
           WHERE run_id = ? AND plan_step_id = ?`,
        )
        .run(code, summary, nowIso(), runId, runningStep.plan_step_id);
    }
    finishRun(runId, "failed", code, summary);
    events.publish("ai.run.failed", `ai-run:${runId}`, { runId, code, summary });
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, errorMessage(error), code);
  } finally {
    if (lockRenewalTimer) clearInterval(lockRenewalTimer);
    if (locksAcquired) {
      getDb().prepare("DELETE FROM ai_resource_locks WHERE run_id = ?").run(runId);
    }
  }
}

async function checkPlanPreconditions(
  planId: string,
  plan: ActionPlan,
  snapshot: PlanStateSnapshot,
  ctx: CapabilityContext,
  registry: CapabilityRegistry,
): Promise<void> {
  for (const step of plan.steps) {
    const capability = registry.get(step.capabilityId);
    assertCapabilityRole(ctx.actor.role, capability.requiredRoles);
    if (capability.version !== step.capabilityVersion) {
      getDb()
        .prepare("UPDATE ai_plans SET status = 'stale', updated_at = ? WHERE id = ?")
        .run(nowIso(), planId);
      throw new HttpError(409, "Capability version changed", "capability_version");
    }
    const condition = await capability.preconditions(
      ctx,
      capability.inputSchema.parse(step.input),
      snapshot.steps[step.id]?.stateVersion ?? null,
    );
    if (!condition.ok) {
      getDb()
        .prepare("UPDATE ai_plans SET status = 'stale', updated_at = ? WHERE id = ?")
        .run(nowIso(), planId);
      throw new HttpError(
        409,
        condition.message ?? "Plan state is stale",
        condition.code ?? "stale_plan",
      );
    }
  }
}

function acquireLocks(runId: string, resourceKeys: string[]): void {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  try {
    getDb().transaction(() => {
      getDb().prepare("DELETE FROM ai_resource_locks WHERE expires_at <= ?").run(now);
      for (const key of resourceKeys) {
        getDb()
          .prepare(
            "INSERT INTO ai_resource_locks(resource_key, run_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
          )
          .run(key, runId, now, expiresAt);
      }
    })();
  } catch {
    throw new HttpError(
      409,
      "A plan is already changing one of these resources",
      "resource_locked",
    );
  }
}

export function renewLocks(runId: string): void {
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  try {
    getDb()
      .prepare("UPDATE ai_resource_locks SET expires_at = ? WHERE run_id = ?")
      .run(expiresAt, runId);
  } catch {
    // A transient SQLite busy period is harmless because the existing lease retains
    // several more minutes and the next heartbeat retries.
  }
}

function setRunState(runId: string, status: "running"): void {
  const now = nowIso();
  getDb().transaction(() => {
    getDb()
      .prepare("UPDATE ai_plan_runs SET status = ?, started_at = ? WHERE id = ?")
      .run(status, now, runId);
    getDb()
      .prepare(
        "UPDATE ai_plans SET status = ?, updated_at = ? WHERE id = (SELECT plan_id FROM ai_plan_runs WHERE id = ?)",
      )
      .run(status, now, runId);
  })();
}

function setStepState(runId: string, stepId: string, status: "running"): void {
  getDb()
    .prepare(
      "UPDATE ai_plan_run_steps SET status = ?, started_at = ? WHERE run_id = ? AND plan_step_id = ?",
    )
    .run(status, nowIso(), runId, stepId);
}

function finishRun(
  runId: string,
  status: "succeeded" | "failed",
  code: string | null,
  summary: string | null,
): void {
  const now = nowIso();
  getDb().transaction(() => {
    getDb()
      .prepare(
        "UPDATE ai_plan_runs SET status = ?, error_code = ?, error_summary = ?, finished_at = ? WHERE id = ?",
      )
      .run(status, code, summary, now, runId);
    getDb()
      .prepare(
        "UPDATE ai_plans SET status = ?, updated_at = ? WHERE id = (SELECT plan_id FROM ai_plan_runs WHERE id = ?)",
      )
      .run(status, now, runId);
  })();
  events.publish("ai.run.finished", `ai-run:${runId}`, { runId, status });
}

function latestRun(planId: string): { id: string } | undefined {
  return getDb()
    .prepare("SELECT id FROM ai_plan_runs WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(planId) as { id: string } | undefined;
}

function planIdForRun(runId: string): string {
  const row = getDb().prepare("SELECT plan_id FROM ai_plan_runs WHERE id = ?").get(runId) as
    | { plan_id: string }
    | undefined;
  if (!row) throw new HttpError(404, "AI run not found", "run_not_found");
  return row.plan_id;
}

function stepIdempotencyKey(
  planId: string,
  stepId: string,
  capabilityId: string,
  version: number,
): string {
  return sha256(`${planId}${stepId}${capabilityId}${version}`);
}

function refreshActor(actor: AuthenticatedActor): AuthenticatedActor {
  const row = getDb()
    .prepare(
      `SELECT u.username, u.role FROM users u
       JOIN sessions s ON s.user_id = u.id
       WHERE u.id = ? AND s.id = ? AND u.disabled = 0 AND s.expires_at > ?`,
    )
    .get(actor.id, actor.sessionId, nowIso()) as
    | { username: string; role: AuthenticatedActor["role"] }
    | undefined;
  if (!row) throw new HttpError(401, "Authentication required", "unauthenticated");
  return { id: actor.id, sessionId: actor.sessionId, username: row.username, role: row.role };
}

export function getRun(runId: string, actor: AuthenticatedActor): AiRunRecord {
  const row = getDb()
    .prepare(
      `SELECT r.id, r.plan_id, r.status, r.error_code, r.error_summary
       FROM ai_plan_runs r JOIN ai_plans p ON p.id = r.plan_id
       JOIN ai_conversations c ON c.id = p.conversation_id
       WHERE r.id = ? AND c.user_id = ?`,
    )
    .get(runId, actor.id) as
    | {
        id: string;
        plan_id: string;
        status: string;
        error_code: string | null;
        error_summary: string | null;
      }
    | undefined;
  if (!row) throw new HttpError(404, "AI run not found", "run_not_found");
  const steps = getDb()
    .prepare(
      `SELECT plan_step_id, capability_id, status, result_json, error_code, error_summary
       FROM ai_plan_run_steps WHERE run_id = ? ORDER BY rowid`,
    )
    .all(runId) as Array<{
    plan_step_id: string;
    capability_id: string;
    status: string;
    result_json: string | null;
    error_code: string | null;
    error_summary: string | null;
  }>;
  return {
    id: row.id,
    planId: row.plan_id,
    status: row.status,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    steps: steps.map((step) => ({
      planStepId: step.plan_step_id,
      capabilityId: step.capability_id,
      status: step.status,
      result: step.result_json ? (JSON.parse(step.result_json) as unknown) : null,
      errorCode: step.error_code,
      errorSummary: step.error_summary,
    })),
  };
}
