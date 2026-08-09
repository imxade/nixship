export type DomainRoute = {
  appId: string;
  appName: string;
  hostname: string;
  publicPort: number;
  status: "not-configured" | "pending" | "managed" | "error";
  zoneId: string | null;
  lastError: string | null;
  lastSyncedAt: string | null;
};

const presentation = {
  "not-configured": { label: "Cloudflare not connected", className: "badge-ghost" },
  pending: { label: "Awaiting sync", className: "badge-warning" },
  managed: { label: "Cloudflare managed", className: "badge-success" },
  error: { label: "Sync failed", className: "badge-error" },
} satisfies Record<DomainRoute["status"], { label: string; className: string }>;

export function DomainRouteStatusBadge({ status }: { status: DomainRoute["status"] }) {
  const value = presentation[status];
  return (
    <span
      className={`badge ${value.className} min-h-6 max-w-full whitespace-normal break-words px-2 py-1 text-left text-xs leading-tight font-medium`}
    >
      {value.label}
    </span>
  );
}
