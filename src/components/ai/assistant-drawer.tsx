"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { usePathname } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { ModelPicker } from "./model-picker";

type Plan = {
  id: string;
  status: string;
  planHash: string;
  risk: "mutation" | "sensitive" | "destructive";
  expiresAt: string;
  plan: {
    goal: string;
    summary: string;
    steps: Array<{
      id: string;
      title: string;
      capabilityId: string;
      expectedEffect: string;
      risk: string;
    }>;
    warnings: string[];
    expectedResult: string;
  };
};

type Run = {
  id: string;
  status: string;
  errorSummary: string | null;
  steps: Array<{ planStepId: string; capabilityId: string; status: string }>;
};

type RunProgress = {
  status: string;
  model?: string;
  percent?: number | null;
  completedBytes?: number | null;
  totalBytes?: number | null;
};

type ProviderStatus = {
  configured: boolean;
  provider: string | null;
  model: string | null;
  remote: boolean;
};

type SecureRequest = {
  prompt: string;
  field: {
    kind: "cloudflare_api_token" | "harbur_token" | "provider_api_key" | "dotenv";
    label: string;
    placeholder?: string;
    multiline: boolean;
    scope: { type: "global" | "app" | "integration" | "ai"; id: string | null };
  };
};

type PlannerOutcome =
  | { type: "answer"; content: string }
  | { type: "request_input"; prompt: string }
  | ({ type: "request_secure_input" } & SecureRequest)
  | { type: "plan"; content: string; plan: Plan };

type NixShipUiMessage = UIMessage<unknown, { outcome: PlannerOutcome }>;

export function AssistantDrawer() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [runProgress, setRunProgress] = useState<RunProgress | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [secureRequest, setSecureRequest] = useState<SecureRequest | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<NixShipUiMessage>({
        api: "/api/ai/chat/stream",
        prepareSendMessagesRequest({ messages: chatMessages, body }) {
          const last = chatMessages.at(-1);
          const text = last?.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
            .trim();
          return {
            body: {
              conversationId:
                typeof body?.conversationId === "string" ? body.conversationId : conversationId,
              text,
            },
          };
        },
      }),
    [conversationId],
  );
  const {
    messages,
    sendMessage,
    setMessages,
    status: chatStatus,
    error: chatError,
  } = useChat<NixShipUiMessage>({
    id: conversationId ?? "nixship-ai-pending",
    transport,
    onData(part) {
      if (part.type !== "data-outcome") return;
      const outcome = part.data;
      if (outcome.type === "plan") setPlan(outcome.plan);
      if (outcome.type === "request_secure_input") setSecureRequest(outcome);
    },
    onError(cause) {
      setError(errorText(cause));
    },
  });
  const busy = actionBusy || chatStatus === "submitted" || chatStatus === "streaming";
  const activeRunId = run?.id;
  const activeRunStatus = run?.status;

  useEffect(() => {
    setOpen(localStorage.getItem("nixship-ai-open") === "true");
  }, []);

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" });
  });

  useEffect(() => {
    if (!activeRunId || ["succeeded", "failed", "cancelled"].includes(activeRunStatus ?? ""))
      return;
    const source = new EventSource(`/api/ai/runs/${activeRunId}/events`);
    const refresh = () => {
      void apiFetch<Run>(`/api/ai/runs/${activeRunId}`)
        .then(setRun)
        .catch(() => undefined);
    };
    source.addEventListener("ai.run.started", refresh);
    source.addEventListener("ai.run.step", refresh);
    source.addEventListener("ai.run.finished", refresh);
    source.addEventListener("ai.run.failed", refresh);
    source.addEventListener("ai.run.progress", (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as { data?: RunProgress };
        if (event.data) setRunProgress(event.data);
      } catch {
        // Ignore malformed client-side progress; authoritative run state is fetched separately.
      }
    });
    source.onerror = refresh;
    return () => source.close();
  }, [activeRunId, activeRunStatus]);

  const ensureConversation = useCallback(async () => {
    if (conversationId) return conversationId;
    const created = await apiFetch<{ id: string }>("/api/ai/conversations", {
      method: "POST",
      body: JSON.stringify({ scope: scopeFromPath(pathname) }),
    });
    setConversationId(created.id);
    return created.id;
  }, [conversationId, pathname]);

  useEffect(() => {
    if (!open) return;
    void ensureConversation();
    void apiFetch<ProviderStatus>("/api/ai/status")
      .then(setProvider)
      .catch(() => undefined);
  }, [open, ensureConversation]);

  function toggle() {
    const next = !open;
    setOpen(next);
    localStorage.setItem("nixship-ai-open", String(next));
  }

  async function newConversation() {
    setActionBusy(true);
    setError("");
    try {
      const created = await apiFetch<{ id: string }>("/api/ai/conversations", {
        method: "POST",
        body: JSON.stringify({ scope: scopeFromPath(pathname) }),
      });
      setConversationId(created.id);
      setMessages([]);
      setPlan(null);
      setRun(null);
      setRunProgress(null);
      setSecureRequest(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActionBusy(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = String(data.get("message") ?? "").trim();
    if (!text || busy) return;
    setError("");
    setPlan(null);
    setRun(null);
    setRunProgress(null);
    setSecureRequest(null);
    form.reset();
    try {
      await sendText(text);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function sendText(text: string) {
    const id = await ensureConversation();
    await sendMessage({ text }, { body: { conversationId: id } });
  }

  async function storeSecureInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secureRequest || busy) return;
    const form = event.currentTarget;
    const value = String(new FormData(form).get("secureValue") ?? "");
    if (!value) return;
    setActionBusy(true);
    setError("");
    try {
      const reference = await apiFetch<{ secretRef: string; kind: string }>("/api/ai/secrets", {
        method: "POST",
        body: JSON.stringify({
          kind: secureRequest.field.kind,
          scope: secureRequest.field.scope,
          value,
        }),
      });
      form.reset();
      setSecureRequest(null);
      const id = await ensureConversation();
      await sendMessage(
        {
          text: `Secure input stored as ${reference.secretRef} (${reference.kind}); plaintext is unavailable to the model.`,
        },
        { body: { conversationId: id } },
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActionBusy(false);
    }
  }

  async function decide(
    action: "approve" | "reject",
    authorization?: { password?: string; destructiveConfirmation?: string },
  ) {
    if (!plan) return;
    setActionBusy(true);
    setError("");
    try {
      if (action === "approve") {
        if (plan.risk === "sensitive" || plan.risk === "destructive") {
          await apiFetch("/api/ai/reauth", {
            method: "POST",
            body: JSON.stringify({ password: authorization?.password }),
          });
        }
        const result = await apiFetch<Run>(`/api/ai/plans/${plan.id}/approve`, {
          method: "POST",
          body: JSON.stringify({
            planHash: plan.planHash,
            destructiveConfirmation: authorization?.destructiveConfirmation,
          }),
        });
        setRun(result);
        setPlan((current) => (current ? { ...current, status: result.status } : null));
      } else {
        const rejected = await apiFetch<Plan>(`/api/ai/plans/${plan.id}/reject`, {
          method: "POST",
          body: JSON.stringify({ planHash: plan.planHash }),
        });
        setPlan(rejected);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={toggle}
          className="btn btn-primary btn-circle fixed bottom-5 right-5 z-40 shadow-xl"
          aria-label="Open Nix Ship assistant"
          aria-expanded={false}
        >
          AI
        </button>
      )}
      {open && (
        <section
          aria-label="Nix Ship assistant"
          className="fixed inset-0 z-30 flex min-w-0 flex-col border-l border-base-300 bg-base-100 shadow-2xl sm:inset-y-0 sm:left-auto sm:w-[min(32rem,92vw)]"
        >
          <header className="flex items-start justify-between gap-3 border-b border-base-300 p-4">
            <div className="min-w-0">
              <h2 className="font-bold">Nix Ship assistant</h2>
              <p className="truncate text-xs text-base-content/60">
                {provider?.configured
                  ? `${provider.model} · ${provider.remote ? "remote" : "local"}`
                  : "Model provider not configured"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void newConversation()}
              >
                New chat
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-square"
                onClick={toggle}
                aria-label="Close assistant drawer"
              >
                ×
              </button>
            </div>
          </header>
          <div ref={thread} className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
            {messages.length === 0 && (
              <div className="rounded-box border border-dashed border-base-300 p-4 text-sm text-base-content/65">
                Ask about current apps and deployments, or request a rename. Read-only questions run
                immediately; changes always stop at an exact approval plan.
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={`chat ${message.role === "user" ? "chat-end" : "chat-start"}`}
              >
                <div
                  className={`chat-bubble whitespace-pre-wrap break-words ${message.role === "user" ? "chat-bubble-primary" : ""}`}
                >
                  {message.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("")}
                </div>
              </div>
            ))}
            {plan && <PlanCard plan={plan} busy={busy} onDecision={decide} />}
            {secureRequest && (
              <SecureInputCard request={secureRequest} busy={busy} onSubmit={storeSecureInput} />
            )}
            {run && <RunCard run={run} progress={runProgress} />}
            {busy && (
              <div className="flex items-center gap-2 text-sm">
                <span className="loading loading-dots loading-sm" /> Working
              </div>
            )}
            {(error || chatError) && (
              <div className="alert alert-error text-sm">
                <span>{error || chatError?.message}</span>
              </div>
            )}
          </div>
          <form onSubmit={send} className="border-t border-base-300 p-4 pb-20 sm:pb-4">
            <label className="form-control">
              <span className="sr-only">Ask Nix Ship</span>
              <textarea
                name="message"
                className="textarea textarea-bordered min-h-20 resize-none"
                placeholder={
                  provider?.configured
                    ? "Ask Nix Ship…"
                    : "Configure AI environment settings first…"
                }
                disabled={busy || provider?.configured === false}
                required
                maxLength={16 * 1024}
              />
            </label>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <ModelPicker conversationId={conversationId} disabled={busy} />
                <span className="block text-xs text-base-content/55">
                  Never paste passwords or API tokens into chat.
                </span>
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={busy || provider?.configured === false}
              >
                Send
              </button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}

function SecureInputCard({
  request,
  busy,
  onSubmit,
}: {
  request: SecureRequest;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <form className="card border border-info/50 bg-base-200" onSubmit={onSubmit}>
      <div className="card-body gap-3 p-4">
        <div>
          <h3 className="font-bold">Secure input</h3>
          <p className="text-sm text-base-content/70">
            This value is encrypted directly and is never added to the chat transcript or model
            request.
          </p>
        </div>
        <label className="form-control gap-1" htmlFor="nixship-ai-secure-input">
          <span className="label-text">{request.field.label}</span>
          {request.field.multiline ? (
            <textarea
              id="nixship-ai-secure-input"
              name="secureValue"
              className="textarea textarea-bordered min-h-28 font-mono"
              placeholder={request.field.placeholder}
              autoComplete="off"
              required
            />
          ) : (
            <input
              id="nixship-ai-secure-input"
              name="secureValue"
              type="password"
              className="input input-bordered"
              placeholder={request.field.placeholder}
              autoComplete="off"
              required
            />
          )}
        </label>
        <div className="card-actions justify-end">
          <button type="submit" className="btn btn-info btn-sm" disabled={busy}>
            Store securely
          </button>
        </div>
      </div>
    </form>
  );
}

function PlanCard({
  plan,
  busy,
  onDecision,
}: {
  plan: Plan;
  busy: boolean;
  onDecision: (
    action: "approve" | "reject",
    authorization?: { password?: string; destructiveConfirmation?: string },
  ) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function approve() {
    await onDecision("approve", {
      password,
      destructiveConfirmation: plan.risk === "destructive" ? confirmation : undefined,
    });
    setPassword("");
  }

  return (
    <article className="card border border-warning/50 bg-base-200">
      <div className="card-body gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">Approval required</h3>
          <span
            className={`badge ${plan.risk === "destructive" ? "badge-error" : "badge-warning"}`}
          >
            {plan.risk}
          </span>
        </div>
        <div>
          <div className="font-medium">{plan.plan.goal}</div>
          <p className="text-sm text-base-content/70">{plan.plan.summary}</p>
        </div>
        <ol className="space-y-2">
          {plan.plan.steps.map((step, index) => (
            <li
              key={step.id}
              className="rounded-box border border-base-300 bg-base-100 p-3 text-sm"
            >
              <div className="font-medium">
                {index + 1}. {step.title}
              </div>
              <div className="text-base-content/65">{step.expectedEffect}</div>
              <code className="mt-1 block break-all text-xs">{step.capabilityId}</code>
            </li>
          ))}
        </ol>
        {plan.plan.warnings.map((warning) => (
          <div key={warning} className="text-sm text-warning">
            {warning}
          </div>
        ))}
        <p className="text-sm">
          <span className="font-medium">Expected:</span> {plan.plan.expectedResult}
        </p>
        {(plan.risk === "sensitive" || plan.risk === "destructive") && (
          <label className="form-control gap-1" htmlFor={`reauth-${plan.id}`}>
            <span className="label-text">Current Nix Ship password</span>
            <input
              id={`reauth-${plan.id}`}
              type="password"
              className="input input-bordered input-sm"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
        )}
        {plan.risk === "destructive" && (
          <label className="form-control gap-1" htmlFor={`confirm-${plan.id}`}>
            <span className="label-text">
              Type <code>DELETE {plan.id}</code>
            </span>
            <input
              id={`confirm-${plan.id}`}
              className="input input-bordered input-sm font-mono"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              required
            />
          </label>
        )}
        {plan.status === "proposed" ? (
          <div className="card-actions justify-end">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => void onDecision("reject")}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn btn-warning btn-sm"
              disabled={
                busy ||
                ((plan.risk === "sensitive" || plan.risk === "destructive") && !password) ||
                (plan.risk === "destructive" && confirmation !== `DELETE ${plan.id}`)
              }
              onClick={() => void approve()}
            >
              Approve exact plan
            </button>
          </div>
        ) : (
          <span className="badge badge-outline">{plan.status}</span>
        )}
      </div>
    </article>
  );
}

function RunCard({ run, progress }: { run: Run; progress: RunProgress | null }) {
  const createdApplication = run.steps.some(
    (step) => step.capabilityId === "apps.createFromSource" && step.status === "succeeded",
  );
  return (
    <article className="card border border-base-300 bg-base-200">
      <div className="card-body gap-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-bold">Verified execution</h3>
          <span className={`badge ${run.status === "succeeded" ? "badge-success" : "badge-error"}`}>
            {run.status}
          </span>
        </div>
        {run.steps.map((step) => (
          <div key={step.planStepId} className="flex items-center gap-2 text-sm">
            <span>{step.status === "succeeded" ? "✓" : step.status === "failed" ? "×" : "○"}</span>
            <span>{step.capabilityId}</span>
          </div>
        ))}
        {progress && (
          <div className="text-sm">
            <div className="flex justify-between gap-2">
              <span>{progress.status}</span>
              {progress.percent !== null && progress.percent !== undefined && (
                <span>{progress.percent.toFixed(1)}%</span>
              )}
            </div>
            {progress.percent !== null && progress.percent !== undefined && (
              <progress
                className="progress progress-primary w-full"
                value={progress.percent}
                max="100"
              />
            )}
          </div>
        )}
        {run.errorSummary && <p className="text-sm text-error">{run.errorSummary}</p>}
        {run.status === "succeeded" && createdApplication && (
          <div className="alert alert-info mt-2 text-sm">
            <span>
              The deployment is healthy. Would you like to add a custom domain? Tell me the exact
              hostname, such as a subdomain of your configured Cloudflare zone. No domain has been
              changed yet.
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

function scopeFromPath(pathname: string): { type: "global" | "app" | "integration"; id?: string } {
  const app = /^\/apps\/([^/]+)$/.exec(pathname);
  if (app?.[1]) return { type: "app", id: app[1] };
  if (pathname.startsWith("/integrations/"))
    return { type: "integration", id: pathname.split("/")[2] };
  return { type: "global" };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The assistant request failed";
}
