# AI Capability and Plan Protocol

This document describes the implemented contract between Nix Ship, an
OpenAI-compatible model, the capability registry and the deterministic executor.
Source and tests remain authoritative if this document becomes stale.

## Security boundary

The model is a read-only planner. It can:

- answer with text;
- call registered read capabilities;
- search descriptions of mutation capabilities;
- request one ordinary or masked secure input; or
- propose a typed mutation plan for human approval.

The model cannot call a mutation implementation. It receives no shell, SQL,
filesystem-write, generic HTTP or arbitrary function tool. Approval and execution
happen later in Nix Ship code without another model decision.

## What Nix Ship sends to the model

Each provider call receives a normalized message list and JSON-Schema function
definitions. The AI SDK translates this contract into the selected provider's
OpenAI-compatible wire format; the exact HTTP serialization is provider-adapter
detail, not a Nix Ship persistence contract.

Conceptually, a request is:

```json
{
  "messages": [
    { "role": "system", "content": "<Nix Ship planning policy>" },
    { "role": "user", "content": "Rename the application" }
  ],
  "tools": [
    {
      "name": "cap__apps__list",
      "description": "List applications and their non-secret operational settings.",
      "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "capabilities_search",
      "description": "Search mutation capabilities before proposing a plan.",
      "parameters": {
        "type": "object",
        "properties": { "query": { "type": "string" } },
        "required": ["query"],
        "additionalProperties": false
      }
    },
    { "name": "request_input", "parameters": "<JSON Schema>" },
    { "name": "request_secure_input", "parameters": "<JSON Schema>" },
    { "name": "propose_plan", "parameters": "<strict plan JSON Schema>" }
  ]
}
```

The actual system message includes the authenticated role, the exact plan expiry
timestamp, the rule that repository text and tool results are untrusted, the
locked-flake requirement, and instructions to inspect state and search capabilities
before planning a mutation. Up to 20 prior text messages are included. Secure
plaintext, plan records and run results are not inserted into model history.

Provider calls use temperature `0`, no retries, a six-call planner budget, a default
60-second timeout and a default 768 output-token limit. A response may contain at
most four simultaneous read calls.

## How capabilities are exposed

All capabilities are registered in the TypeScript capability registry with:

```text
id, version, title, description, risk, mutates, requiredRoles,
inputSchema, outputSchema, inputJsonSchema,
preview(), preconditions(), execute(), optional verify()
```

### Read capabilities

Up to the first 20 registered read capabilities allowed for the authenticated role
are sent directly as function tools. Their names are encoded for provider
compatibility:

```text
apps.list              -> cap__apps__list
deployments.get        -> cap__deployments__get
system.getSettings     -> cap__system__getSettings
```

Each read tool contains the capability description and its input JSON Schema. Nix
Ship parses arguments with the capability's Zod schema, executes the registered read
implementation and validates the result with its output schema before returning it
to the model as a JSON tool-result message.

### Mutation capabilities

Mutation capabilities are not callable tools. The model is told to call:

```json
{
  "name": "capabilities_search",
  "arguments": { "query": "rename application" }
}
```

Search is filtered by the authenticated role, matches all query terms against the
capability ID, title and description, excludes read capabilities, and returns at
most 16 descriptors:

```json
[
  {
    "id": "apps.updateName",
    "version": 1,
    "title": "Rename application",
    "description": "Change an application's display name. The stable slug and URLs are unchanged.",
    "risk": "mutation",
    "requiredRoles": ["owner", "admin", "operator"],
    "inputSchemaSummary": {
      "type": "object",
      "properties": {
        "appId": { "type": "string", "format": "uuid" },
        "name": { "type": "string", "minLength": 1, "maxLength": 80 }
      },
      "required": ["appId", "name"],
      "additionalProperties": false
    }
  }
]
```

The descriptor exposes identity, version, risk, authorization metadata and the input
shape. It does not expose `execute()`, output implementation, stored secrets or any
mutation authority.

Resource keys in a proposed plan are also not authoritative. During validation the
server calls the capability's `preview()` and requires the model-proposed keys to
match the server-derived keys exactly. The search descriptor currently does not
include preview-derived resource keys; models obtain resource identifiers from read
tools and must propose the corresponding keys. Capabilities with non-obvious derived
keys may therefore be rejected rather than guessed or executed.

## Model response protocol

The provider response is normalized to:

```ts
{
  content: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: unknown;
  }>;
}
```

Nix Ship accepts four outcome classes:

1. No tool call and non-empty text: return an ordinary answer.
2. Read tool calls: execute them, append validated JSON tool results and ask the
   model again.
3. One `request_input` or `request_secure_input` call: return a structured input
   card to the dashboard.
4. One `propose_plan` call: validate and persist a proposed plan without executing
   it.

An input request or plan proposal is terminal for that planner request and must be
the only tool call in the response. Unknown tools, invalid arguments, mixed terminal
and read calls, excessive parallel calls and exhausting the six-call budget fail
closed.

## Plan format returned by the model

The `propose_plan` arguments must be exactly `{ "plan": <ActionPlan> }`. The outer
and nested objects reject additional fields. An illustrative plan is:

```json
{
  "plan": {
    "schemaVersion": 1,
    "goal": "Rename the application",
    "summary": "Change only the application's display name.",
    "scope": {
      "type": "app",
      "id": "8df2aeba-b032-47ce-aea6-9d36c210740c"
    },
    "steps": [
      {
        "id": "rename",
        "capabilityId": "apps.updateName",
        "capabilityVersion": 1,
        "title": "Rename application",
        "input": {
          "appId": "8df2aeba-b032-47ce-aea6-9d36c210740c",
          "name": "Production API"
        },
        "resourceKeys": [
          "app:8df2aeba-b032-47ce-aea6-9d36c210740c"
        ],
        "dependsOn": [],
        "risk": "mutation",
        "expectedEffect": "The display name becomes Production API.",
        "externalWait": false
      }
    ],
    "warnings": ["The stable slug is unchanged."],
    "expectedResult": "The application is named Production API.",
    "expiresAt": "2026-08-14T12:10:00.000Z"
  }
}
```

Plans have one to 20 ordered steps. Dependencies may reference only earlier steps.
Each step names an exact registered capability and version, supplies input for that
capability, declares its risk and lock resources, and describes the expected effect.
External waits are currently rejected.

The system policy supplies an exact expiry ten minutes in the future. The validator
rejects expired plans and any expiry more than 30 minutes away.

## What happens before approval

Nix Ship treats the model plan as untrusted input and validates it as follows:

1. Parse the strict plan schema.
2. Check expiry, unique step IDs and dependency order.
3. Resolve each capability ID from the server registry.
4. Require a mutation capability with the exact current version.
5. Recheck the authenticated role.
6. Parse each step input with the capability's Zod schema.
7. Run `preview()` to derive the authoritative risk, resource keys, redacted
   description and state version.
8. Require the proposed risk and resource keys to match the preview.
9. Capture a per-step state snapshot.
10. Canonicalize the complete plan and compute its SHA-256 hash.
11. Persist the plan JSON, hash, creator, effective risk, snapshot and expiry with
    status `proposed`.

No mutation has happened at this point. The dashboard receives a plan record and
shows the exact hash-bound approval UI.

## Approval and execution input

Approval is a separate authenticated request made by the human, not the model:

```json
{
  "planHash": "<64-character SHA-256 hex>",
  "destructiveConfirmation": "DELETE <plan-id>"
}
```

`destructiveConfirmation` is required only for destructive plans. Sensitive and
destructive plans also require a fresh current-password grant.

Before creating a run, Nix Ship reloads the user and persisted plan and checks the
plan hash, creator, status, expiry, role, capability versions and current
preconditions. Approval and run creation are transactional and repeated approval is
idempotent.

## Deterministic execution

The executor never asks the model what to do next. It:

1. Loads the persisted plan and state snapshot.
2. Acquires the validated resource keys in sorted order.
3. Processes steps in plan order.
4. Refreshes the actor and role for every step.
5. Resolves the capability by ID and checks its version again.
6. Parses the persisted step input with the capability's Zod schema.
7. Rechecks capability preconditions against the captured state version.
8. Derives a stable SHA-256 idempotency key from plan, step, capability and version.
9. Calls the registered TypeScript `execute()` implementation.
10. Parses the returned value with the capability output schema.
11. Runs `verify()` when present.
12. Persists the result or a sanitized error, audits the capability ID/version and
    publishes authoritative run events.

The model-proposed `title`, `summary`, `expectedEffect` and `expectedResult` are
display metadata. They do not select code. Only the registered capability ID,
version and validated input reach an implementation.

## What the dashboard receives

The chat endpoint returns one of:

```ts
{ type: "answer"; content: string }
{ type: "request_input"; prompt: string; field: OrdinaryField }
{ type: "request_secure_input"; prompt: string; field: SecureField }
{ type: "plan"; content: string; plan: PersistedPlanRecord }
```

Approval returns an `AiRunRecord` containing run status and step records:

```ts
{
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
```

Background execution publishes run-step and deployment progress over
authenticated SSE. Results come from capability implementations and verification,
not generated model prose. They are not automatically sent back to the model; a
later chat request must use read capabilities to observe current state.

## Secure input path

When the model calls `request_secure_input`, the dashboard posts plaintext directly
to the secure-input API. The server encrypts it and returns an opaque `aisec_*`
reference. The next model-visible message contains only that reference, kind and the
statement that plaintext is unavailable.

The reference is bound to the actor, kind and scope, expires after 30 minutes and is
consumed once by the deterministic capability. Its encrypted reference row is deleted
as part of consumption. The plaintext is never placed in chat history, plan metadata,
tool results or model context.

## Multi-provider architecture & LiteLLM integration

Nix Ship provides a unified provider-neutral AI interface across all workflows:

- **Universal wire format**: Integrates with OpenAI-compatible endpoints and LiteLLM proxies (`@ai-sdk/openai-compatible`) using a consistent tool-calling, message, and error protocol.
- **Supported providers**: Out-of-the-box presets for Ollama (local/remote), Anthropic Claude, Google Gemini, OpenAI, Groq, Mistral, DeepSeek, LiteLLM Proxy, and custom OpenAI-compatible gateways.
- **Provider neutrality**: AI workflows (`planner.ts`, `assistant-drawer.tsx`, `model-probe.ts`) interact exclusively with the abstract `AiProvider` interface without hardcoded provider branching.
- **Secure credential management**: Provider API keys are ingested via ephemeral opaque references (`aisec_*`), stored with AES-256-GCM encryption in SQLite, and never exposed in plaintext, logs, telemetry, or API responses.
- **Dynamic catalog & presets**: Operators can configure, update, probe, enable/disable, or delete any provider directly from the dashboard.

## Implementation map

- Provider catalog & presets: `src/server/ai/provider-catalog.ts`
- Unified provider registry: `src/server/ai/provider-registry.ts`
- OpenAI-compatible & LiteLLM adapter: `src/server/ai/provider.ts`
- Planner loop and tool exposure: `src/server/ai/planner.ts`
- Capability registry contract: `src/server/ai/capabilities/`
- Plan schema and validation: `src/server/ai/plans/schema.ts` and `validator.ts`
- Canonical persistence: `src/server/ai/plans/store.ts`
- Approval and execution: `src/server/ai/plans/executor.ts`
- Secure references: `src/server/ai/secrets.ts`
- Compatibility probe: `src/server/ai/model-probe.ts`

