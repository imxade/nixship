export function StatusBadge({ state, className = "" }: { state: string; className?: string }) {
  const positive = ["running", "processed", "active", "connected"].includes(state);
  const pending = [
    "queued",
    "preparing",
    "fetching",
    "evaluating",
    "starting",
    "health-checking",
    "activating",
  ].includes(state);
  const neutral = ["stopped", "superseded", "not-deployed", "cancelled"].includes(state);
  const cls = positive
    ? "badge-success"
    : pending
      ? "badge-warning"
      : neutral
        ? "badge-ghost"
        : "badge-error";
  const label = state.replaceAll("-", " ");
  return (
    <span
      className={`badge ${cls} min-h-6 max-w-full whitespace-normal break-words px-2 py-1 text-left text-xs leading-tight font-medium ${className}`}
    >
      {label}
    </span>
  );
}
