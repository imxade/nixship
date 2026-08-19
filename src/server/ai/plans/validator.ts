import { HttpError } from "../../errors.ts";
import { aiMaxPlanLifetimeMs } from "../ai-settings.ts";
import { assertCapabilityRole, type CapabilityRegistry } from "../capabilities/registry.ts";
import type { CapabilityContext, CapabilityRisk } from "../capabilities/types.ts";
import { canonicalHash } from "./canonicalize.ts";
import {
  type ActionPlan,
  actionPlanSchema,
  type PlanRisk,
  type PlanStateSnapshot,
} from "./schema.ts";

const RESOURCE_KEY = /^[a-z][a-z0-9-]*:[A-Za-z0-9._:@/-]{1,256}$/;

export interface ValidatedPlan {
  plan: ActionPlan;
  hash: string;
  risk: PlanRisk;
  snapshot: PlanStateSnapshot;
}

export async function validatePlan(
  raw: unknown,
  ctx: CapabilityContext,
  registry: CapabilityRegistry,
): Promise<ValidatedPlan> {
  const plan = actionPlanSchema.parse(raw);
  const expiry = Date.parse(plan.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + aiMaxPlanLifetimeMs()
  ) {
    throw new HttpError(
      400,
      "Plan expiry must be within the next 30 minutes",
      "invalid_plan_expiry",
    );
  }

  const ids = new Set<string>();
  const snapshot: PlanStateSnapshot = { steps: {} };
  let effectiveRisk: PlanRisk = "mutation";
  for (const step of plan.steps) {
    if (ids.has(step.id))
      throw new HttpError(400, `Duplicate plan step: ${step.id}`, "invalid_plan");
    if (step.dependsOn.some((dependency) => !ids.has(dependency))) {
      throw new HttpError(400, `Step ${step.id} has an invalid dependency order`, "invalid_plan");
    }
    ids.add(step.id);
    const capability = registry.get(step.capabilityId);
    if (!capability.mutates) {
      throw new HttpError(400, "Plans may contain only mutation capabilities", "invalid_plan");
    }
    if (step.externalWait) {
      throw new HttpError(
        400,
        `External waits are not supported by ${step.capabilityId}`,
        "external_wait_unsupported",
      );
    }
    if (capability.version !== step.capabilityVersion) {
      throw new HttpError(
        409,
        `Capability version changed: ${step.capabilityId}`,
        "capability_version",
      );
    }
    assertCapabilityRole(ctx.actor.role, capability.requiredRoles);
    const input = capability.inputSchema.parse(step.input);
    const preview = await capability.preview(ctx, input);
    const expectedRisk = capability.risk as Exclude<CapabilityRisk, "read">;
    if (step.risk !== expectedRisk) {
      throw new HttpError(400, `Risk mismatch for ${step.capabilityId}`, "invalid_plan_risk");
    }
    const requestedResources = [...new Set(step.resourceKeys)].sort();
    const actualResources = [...new Set(preview.resourceKeys)].sort();
    if (
      actualResources.some((key) => !RESOURCE_KEY.test(key)) ||
      JSON.stringify(requestedResources) !== JSON.stringify(actualResources)
    ) {
      throw new HttpError(
        400,
        `Resource keys do not match ${step.capabilityId}`,
        "invalid_resource_key",
      );
    }
    effectiveRisk = maxRisk(effectiveRisk, expectedRisk);
    snapshot.steps[step.id] = {
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      stateVersion: preview.stateVersion,
    };
  }
  return { plan, hash: canonicalHash(plan), risk: effectiveRisk, snapshot };
}

function maxRisk(left: PlanRisk, right: PlanRisk): PlanRisk {
  const rank: Record<PlanRisk, number> = { mutation: 0, sensitive: 1, destructive: 2 };
  return rank[right] > rank[left] ? right : left;
}
