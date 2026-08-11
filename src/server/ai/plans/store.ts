import crypto from "node:crypto";
import { audit } from "../../audit.ts";
import type { AuthenticatedActor } from "../../auth.ts";
import { getDb, nowIso } from "../../db.ts";
import { HttpError } from "../../errors.ts";
import type { ActionPlan, PlanRisk, PlanStateSnapshot } from "./schema.ts";
import type { ValidatedPlan } from "./validator.ts";

export interface AiPlanRecord {
  id: string;
  conversationId: string;
  createdBy: string;
  status: string;
  plan: ActionPlan;
  planHash: string;
  snapshot: PlanStateSnapshot;
  risk: PlanRisk;
  expiresAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AiPlanRow {
  id: string;
  conversation_id: string;
  created_by: string;
  status: string;
  plan_json: string;
  plan_hash: string;
  state_snapshot_json: string;
  risk: PlanRisk;
  expires_at: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export function persistProposedPlan(
  conversationId: string,
  actor: AuthenticatedActor,
  validated: ValidatedPlan,
): AiPlanRecord {
  assertConversationOwner(conversationId, actor.id);
  const id = crypto.randomUUID();
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO ai_plans(
        id, conversation_id, created_by, status, schema_version, plan_json, plan_hash,
        state_snapshot_json, risk, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'proposed', 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      conversationId,
      actor.id,
      JSON.stringify(validated.plan),
      validated.hash,
      JSON.stringify(validated.snapshot),
      validated.risk,
      validated.plan.expiresAt,
      now,
      now,
    );
  audit({
    userId: actor.id,
    action: "ai.plan_proposed",
    entityType: "ai_plan",
    entityId: id,
    details: {
      planHash: validated.hash,
      capabilityIds: validated.plan.steps.map((step) => step.capabilityId),
      risk: validated.risk,
    },
  });
  return getPlan(id, actor);
}

export function getPlan(id: string, actor: AuthenticatedActor): AiPlanRecord {
  const row = getDb()
    .prepare(
      `SELECT p.* FROM ai_plans p
       JOIN ai_conversations c ON c.id = p.conversation_id
       WHERE p.id = ? AND c.user_id = ?`,
    )
    .get(id, actor.id) as AiPlanRow | undefined;
  if (!row) throw new HttpError(404, "AI plan not found", "plan_not_found");
  return mapPlan(row);
}

export function rejectPlan(id: string, hash: string, actor: AuthenticatedActor): AiPlanRecord {
  const plan = getPlan(id, actor);
  if (plan.planHash !== hash)
    throw new HttpError(409, "Plan hash does not match", "plan_hash_mismatch");
  if (plan.status !== "proposed") {
    throw new HttpError(409, "Only a proposed plan can be rejected", "invalid_plan_state");
  }
  getDb()
    .prepare(
      "UPDATE ai_plans SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'proposed'",
    )
    .run(nowIso(), id);
  audit({
    userId: actor.id,
    action: "ai.plan_rejected",
    entityType: "ai_plan",
    entityId: id,
    details: { planHash: hash },
  });
  return getPlan(id, actor);
}

export function cancelPlan(id: string, hash: string, actor: AuthenticatedActor): AiPlanRecord {
  const plan = getPlan(id, actor);
  if (plan.planHash !== hash)
    throw new HttpError(409, "Plan hash does not match", "plan_hash_mismatch");
  if (plan.status !== "proposed") {
    throw new HttpError(
      409,
      "Only a plan awaiting approval can be cancelled; running effects cannot be interrupted safely",
      "invalid_plan_state",
    );
  }
  getDb()
    .prepare(
      "UPDATE ai_plans SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'proposed'",
    )
    .run(nowIso(), id);
  audit({
    userId: actor.id,
    action: "ai.plan_cancelled",
    entityType: "ai_plan",
    entityId: id,
    details: { planHash: hash },
  });
  return getPlan(id, actor);
}

export function assertConversationOwner(conversationId: string, userId: string): void {
  const row = getDb()
    .prepare("SELECT 1 FROM ai_conversations WHERE id = ? AND user_id = ?")
    .get(conversationId, userId);
  if (!row) throw new HttpError(404, "AI conversation not found", "conversation_not_found");
}

function mapPlan(row: AiPlanRow): AiPlanRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    createdBy: row.created_by,
    status: row.status,
    plan: JSON.parse(row.plan_json) as ActionPlan,
    planHash: row.plan_hash,
    snapshot: JSON.parse(row.state_snapshot_json) as PlanStateSnapshot,
    risk: row.risk,
    expiresAt: row.expires_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
