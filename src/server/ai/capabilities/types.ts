import type { z } from "zod";
import type { AuthenticatedActor } from "../../auth.ts";
import type { Role } from "../../types.ts";

export type CapabilityRisk = "read" | "mutation" | "sensitive" | "destructive";

export interface CapabilityContext {
  actor: AuthenticatedActor;
  requestId: string;
}

export interface CapabilityPreview {
  summary: string;
  resourceKeys: string[];
  stateVersion: string | null;
  redactedInput: Record<string, unknown>;
}

export interface PreconditionResult {
  ok: boolean;
  code?: string;
  message?: string;
  stateVersion: string | null;
}

export interface VerificationResult {
  ok: boolean;
  message: string;
}

export interface Capability<TInput = unknown, TOutput = unknown> {
  id: string;
  version: number;
  title: string;
  description: string;
  risk: CapabilityRisk;
  mutates: boolean;
  requiredRoles: Role[];
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  inputJsonSchema: Record<string, unknown>;
  preview(ctx: CapabilityContext, input: TInput): Promise<CapabilityPreview>;
  preconditions(
    ctx: CapabilityContext,
    input: TInput,
    expectedStateVersion: string | null,
  ): Promise<PreconditionResult>;
  execute(
    ctx: CapabilityContext,
    input: TInput,
    meta: {
      planId: string;
      runId: string;
      stepId: string;
      idempotencyKey: string;
    },
  ): Promise<TOutput>;
  verify?(ctx: CapabilityContext, input: TInput, output: TOutput): Promise<VerificationResult>;
}

export interface CapabilityDescriptor {
  id: string;
  version: number;
  title: string;
  description: string;
  risk: CapabilityRisk;
  requiredRoles: Role[];
  inputSchemaSummary: Record<string, unknown>;
}
