import { z } from "zod";
import { audit } from "./audit.ts";
import { setSetting, setting } from "./db.ts";

export const DEFAULT_ACTIVE_DEPLOYMENT_LIMIT = 1;
export const MAX_ACTIVE_DEPLOYMENT_LIMIT = 20;
const SETTING_KEY = "active_deployment_limit";

const activeDeploymentLimitSchema = z.coerce.number().int().min(1).max(MAX_ACTIVE_DEPLOYMENT_LIMIT);

export function activeDeploymentLimit(): number {
  const parsed = activeDeploymentLimitSchema.safeParse(setting(SETTING_KEY));
  return parsed.success ? parsed.data : DEFAULT_ACTIVE_DEPLOYMENT_LIMIT;
}

export function updateActiveDeploymentLimit(
  raw: unknown,
  actor?: { id: string; ip?: string | null },
): number {
  const value = activeDeploymentLimitSchema.parse(raw);
  setSetting(SETTING_KEY, String(value));
  audit({
    userId: actor?.id,
    ip: actor?.ip,
    action: "settings.active_deployment_limit_updated",
    entityType: "setting",
    entityId: SETTING_KEY,
    details: { value },
  });
  return value;
}
