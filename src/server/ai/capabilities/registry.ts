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

  has(id: string): boolean {
    return this.entries.has(id);
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
    const stopWords = new Set(["a", "an", "the", "as", "from", "to", "in", "for", "of", "with", "on", "and", "or"]);
    const terms = (options.query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((t) => t.length > 0 && !stopWords.has(t));
    return [...this.entries.values()]
      .filter((capability) => !options.readOnly || !capability.mutates)
      .filter((capability) => !options.role || capability.requiredRoles.includes(options.role))
      .map((capability) => {
        if (terms.length === 0) return { capability, score: 1 };
        const haystack =
          `${capability.id} ${capability.title} ${capability.description}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) score += 1;
        }
        return { capability, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
      .map(({ capability }) => ({
        id: capability.id,
        version: capability.version,
        title: capability.title,
        description: capability.description,
        risk: capability.risk,
        requiredRoles: capability.requiredRoles,
        inputSchemaSummary: capability.inputJsonSchema,
      }));
  }
}

export function assertCapabilityRole(role: Role, allowed: Role[]): void {
  if (!allowed.includes(role)) {
    throw new HttpError(403, "You do not have permission to use this capability", "forbidden");
  }
}
