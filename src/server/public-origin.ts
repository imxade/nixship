import { config } from "./config.ts";
import { getDb } from "./db.ts";

export type PublicDashboardRouteKind = "custom-domain" | "configured-url" | "quick-tunnel";

export interface PublicDashboardRoute {
  baseUrl: string;
  kind: PublicDashboardRouteKind;
  stable: boolean;
}

/**
 * Selects the public dashboard origin used for inbound integrations.
 * LAN addresses are intentionally excluded because GitHub and other providers
 * cannot reach them. A configured custom domain wins over every temporary route.
 */
export function preferredPublicDashboardRoute(): PublicDashboardRoute | null {
  const cloudflare = getDb()
    .prepare("SELECT dashboard_hostname, enabled FROM cloudflare_config WHERE singleton = 1")
    .get() as { dashboard_hostname: string | null; enabled: number } | undefined;
  if (cloudflare?.enabled && cloudflare.dashboard_hostname) {
    return {
      baseUrl: `https://${cloudflare.dashboard_hostname}`,
      kind: "custom-domain",
      stable: true,
    };
  }

  const explicit = config.PLATFORM_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (explicit) {
    return { baseUrl: explicit, kind: "configured-url", stable: true };
  }

  const quick = getDb()
    .prepare(
      "SELECT url FROM quick_tunnels WHERE key = 'dashboard' AND status = 'running' AND url IS NOT NULL",
    )
    .get() as { url: string } | undefined;
  if (quick?.url) {
    return { baseUrl: quick.url, kind: "quick-tunnel", stable: false };
  }
  return null;
}
