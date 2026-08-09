import type { CloudflareDomainRoute } from "./cloudflare.ts";
import { lanHttpUrls } from "./network.ts";
import type { QuickTunnelRoute } from "./quick-tunnels.ts";

export type AccessLinkKind = "lan" | "temporary" | "custom";
export type AccessLinkStatus = "available" | "starting" | "unavailable" | "configured";

export interface AccessLink {
  kind: AccessLinkKind;
  label: string;
  url: string;
  status: AccessLinkStatus;
  note: string | null;
}

export function dashboardAccessLinks(input: {
  port: number;
  quickTunnel: QuickTunnelRoute | null;
  customHostname: string | null;
  namedTunnelEnabled: boolean;
  namedTunnelRunning: boolean;
}): AccessLink[] {
  const links: AccessLink[] = lanHttpUrls(input.port).map((url) => ({
    kind: "lan",
    label: "LAN",
    url,
    status: "available",
    note: null,
  }));
  if (input.quickTunnel?.running && input.quickTunnel.url) {
    links.push({
      kind: "temporary",
      label: "Temporary public URL",
      url: input.quickTunnel.url,
      status: "available",
      note: null,
    });
  }
  if (input.customHostname) {
    links.push({
      kind: "custom",
      label: "Custom domain",
      url: `https://${input.customHostname}`,
      status:
        input.namedTunnelEnabled && input.namedTunnelRunning
          ? "available"
          : input.namedTunnelEnabled
            ? "starting"
            : "configured",
      note: input.namedTunnelEnabled
        ? "Managed by the persistent named tunnel."
        : "Configured, but the named tunnel is disabled.",
    });
  }
  return links;
}

export function applicationAccessLinks(input: {
  publicPort: number | null;
  applicationStatus: string;
  quickTunnel: QuickTunnelRoute | null;
  customRoutes: CloudflareDomainRoute[];
  namedTunnelEnabled: boolean;
  namedTunnelRunning: boolean;
}): AccessLink[] {
  if (!input.publicPort) return [];
  const serviceStatus = applicationLinkStatus(input.applicationStatus);
  const serviceNote =
    serviceStatus === "available"
      ? null
      : serviceStatus === "starting"
        ? `The application is currently ${input.applicationStatus}.`
        : `The URL is configured, but the application is ${input.applicationStatus}.`;
  const links: AccessLink[] = lanHttpUrls(input.publicPort).map((url) => ({
    kind: "lan",
    label: "LAN",
    url,
    status: serviceStatus,
    note: serviceNote,
  }));
  if (input.quickTunnel?.running && input.quickTunnel.url) {
    links.push({
      kind: "temporary",
      label: "Temporary public URL",
      url: input.quickTunnel.url,
      status: serviceStatus,
      note: serviceNote,
    });
  }
  for (const route of input.customRoutes) {
    const routeReady =
      route.status === "managed" && input.namedTunnelEnabled && input.namedTunnelRunning;
    const routeStarting =
      route.status === "pending" || (route.status === "managed" && input.namedTunnelEnabled);
    links.push({
      kind: "custom",
      label: route.hostname,
      url: `https://${route.hostname}`,
      status: routeReady
        ? serviceStatus
        : routeStarting
          ? "starting"
          : route.status === "managed"
            ? "configured"
            : "unavailable",
      note:
        route.lastError ??
        (routeReady
          ? serviceNote
          : route.status === "pending"
            ? "Cloudflare DNS setup is still pending."
            : null),
    });
  }
  return links;
}

function applicationLinkStatus(status: string): AccessLinkStatus {
  if (status === "running") return "available";
  if (
    [
      "queued",
      "preparing",
      "fetching",
      "evaluating",
      "starting",
      "health-checking",
      "activating",
    ].includes(status)
  ) {
    return "starting";
  }
  return "unavailable";
}
