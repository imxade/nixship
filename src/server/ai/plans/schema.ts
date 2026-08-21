import { z } from "zod";

export const planRiskSchema = z.enum(["mutation", "sensitive", "destructive"]);

export const planStepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    capabilityId: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/),
    capabilityVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(160),
    input: z.unknown(),
    resourceKeys: z.array(z.string().min(1).max(300)).max(20),
    dependsOn: z.array(z.string()).max(20),
    risk: planRiskSchema,
    expectedEffect: z.string().trim().min(1).max(1000),
    externalWait: z.boolean().default(false),
  })
  .strict();

export const actionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    goal: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(2000),
    scope: z
      .object({
        type: z.enum(["global", "app", "deployment", "integration", "ai"]),
        id: z.string().max(200).nullable(),
      })
      .strict(),
    steps: z.array(planStepSchema).min(1).max(20),
    warnings: z.array(z.string().max(1000)).max(20),
    expectedResult: z.string().trim().min(1).max(2000),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanRisk = z.infer<typeof planRiskSchema>;

export interface PlanStateSnapshot {
  steps: Record<
    string,
    {
      capabilityId: string;
      capabilityVersion: number;
      stateVersion: string | null;
    }
  >;
}
