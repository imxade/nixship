import { describe, expect, it } from "vitest";
import { probeActionPlanner } from "../../src/server/ai/model-probe.ts";
import type { AiProvider, ProviderMessage, ProviderTool } from "../../src/server/ai/provider.ts";

describe("action-planner model compatibility", () => {
  it("qualifies a deterministic strict tool model", async () => {
    const report = await probeActionPlanner(new ProbeProvider(false));
    expect(report.actionPlannerCapable).toBe(true);
    expect(report.checks).toHaveLength(10);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });

  it("keeps an answer model in answer-only mode when strict tool input fails", async () => {
    const report = await probeActionPlanner(new ProbeProvider(true));
    expect(report.actionPlannerCapable).toBe(false);
    expect(report.checks).toContainEqual({
      name: "no invented schema fields",
      passed: false,
      detail: "failed",
    });
  });
});

class ProbeProvider implements AiProvider {
  readonly id = "probe-provider";
  readonly modelId = "probe-model";

  constructor(private readonly addInvalidField: boolean) {}

  async complete(messages: ProviderMessage[], tools: ProviderTool[]) {
    const tool = tools[0];
    if (tool?.name === "probe_read" && messages.at(-1)?.role === "user") {
      return {
        content: null,
        toolCalls: [
          {
            id: "read",
            name: "probe_read",
            arguments: {
              target: {
                id: "app-probe",
                detail: "summary",
                ...(this.addInvalidField ? { invented: true } : {}),
              },
            },
          },
        ],
      };
    }
    if (messages.at(-1)?.role === "tool") {
      return { content: `Observed ${messages.at(-1)?.content}`, toolCalls: [] };
    }
    if (tool?.name === "capabilities_search") {
      return {
        content: null,
        toolCalls: [
          {
            id: "search",
            name: "capabilities_search",
            arguments: { query: "rename application" },
          },
        ],
      };
    }
    if (tool?.name === "propose_plan") {
      return {
        content: null,
        toolCalls: [
          {
            id: "plan",
            name: "propose_plan",
            arguments: {
              proposal: {
                capabilityId: "apps.updateName",
                capabilityVersion: 1,
                risk: "mutation",
                input: { appId: "app-probe", name: "Renamed" },
              },
            },
          },
        ],
      };
    }
    if (messages.at(-1)?.content.includes("secretRef")) {
      return { content: "That opaque reference has no plaintext available to me.", toolCalls: [] };
    }
    return { content: "The untrusted request cannot add a mutation tool.", toolCalls: [] };
  }
}
