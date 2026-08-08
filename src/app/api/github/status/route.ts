import type { NextRequest } from "next/server";
import { config } from "@/server/config";
import { getDb } from "@/server/db";
import { getGitHubApp, installUrl } from "@/server/github";
import { api } from "@/server/http";
import { requestUser } from "@/server/next-auth";
import { preferredPublicDashboardRoute } from "@/server/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return api(request, () => {
    const user = requestUser(request);
    const app = getGitHubApp();
    const installations = getDb()
      .prepare(
        "SELECT id, account_login, account_type, repository_selection, suspended_at FROM github_installations ORDER BY account_login",
      )
      .all();
    const webhookRoute = preferredPublicDashboardRoute();
    return {
      connected: Boolean(app),
      canManage: user.role === "owner" || user.role === "admin",
      app: app
        ? { appId: app.app_id, slug: app.slug, htmlUrl: app.html_url, installUrl: installUrl() }
        : null,
      installations,
      webhook: {
        active: Boolean(webhookRoute),
        route: webhookRoute,
        reconciliationSeconds: config.SOURCE_POLL_SECONDS,
      },
    };
  });
}
