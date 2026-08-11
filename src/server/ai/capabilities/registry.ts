import { HttpError } from "../../errors.ts";
import type { Role } from "../../types.ts";
import type { Capability, CapabilityDescriptor } from "./types.ts";

const SAFE_CAPABILITY_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

export class CapabilityRegistry {
  private readonly entries = new Map<string, Capability<unknown, unknown>>();

  register<TInput, TOutput>(capability: Capability<TInput, TOutput>): void {
    if (!SAFE_CAPABILITY_ID.test(capability.id)) {
      throw new Error(`Invalid capability ID: ${capability.id}`);
    }
    if (!Number.isSafeInteger(capability.version) || capability.version < 1) {
      throw new Error(`Invalid capability version: ${capability.id}`);
    }
    if (this.entries.has(capability.id)) {
      throw new Error(`Duplicate capability ID: ${capability.id}`);
    }
    if (capability.mutates === (capability.risk === "read")) {
      throw new Error(`Capability risk/mutation mismatch: ${capability.id}`);
    }
    this.entries.set(capability.id, capability as Capability<unknown, unknown>);
  }

  get(id: string): Capability<unknown, unknown> {
    const capability = this.entries.get(id);
    if (!capability) {
      throw new HttpError(400, `Unknown capability: ${id}`, "unknown_capability");
    }
    return capability;
  }

  descriptors(
    options: { query?: string; role?: Role; readOnly?: boolean } = {},
  ): CapabilityDescriptor[] {
    const terms = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.entries.values()]
      .filter((capability) => !options.readOnly || !capability.mutates)
      .filter((capability) => !options.role || capability.requiredRoles.includes(options.role))
      .filter((capability) => {
        if (terms.length === 0) return true;
        const haystack =
          `${capability.id} ${capability.title} ${capability.description}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .map((capability) => ({
        id: capability.id,
        version: capability.version,
        title: capability.title,
        description: capability.description,
        risk: capability.risk,
        requiredRoles: capability.requiredRoles,
        inputSchemaSummary: capability.inputJsonSchema,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function assertCapabilityRole(role: Role, allowed: Role[]): void {
  if (!allowed.includes(role)) {
    throw new HttpError(403, "You do not have permission to use this capability", "forbidden");
  }
}
