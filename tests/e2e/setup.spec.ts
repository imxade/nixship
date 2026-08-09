import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("owner setup, session auth, origin checks, and viewer RBAC work end to end", async ({
  browser,
  page,
  request,
}) => {
  const dataDirectory = path.resolve(
    process.env.E2E_DATA_DIR || path.join(process.cwd(), ".e2e-data"),
  );
  const tokenPath = path.join(dataDirectory, "setup-token.txt");
  const token = fs.readFileSync(tokenPath, "utf8").trim();

  const unauthenticated = await request.get("/api/apps");
  expect(unauthenticated.status()).toBe(401);

  const setupDocument = await request.get("/setup");
  const setupHtml = await setupDocument.text();
  expect(setupDocument.ok()).toBe(true);
  expect(setupDocument.headers()["content-security-policy"]).not.toContain("'unsafe-eval'");
  expect(setupHtml.indexOf('src="/theme-init.js"')).toBeGreaterThan(-1);
  expect(setupHtml.indexOf('src="/theme-init.js"')).toBeLessThan(setupHtml.indexOf("<body"));
  expect((await request.get("/theme-init.js")).ok()).toBe(true);
  const logoAsset = await request.get("/nixship-mark.png");
  expect(logoAsset.ok()).toBe(true);
  expect(logoAsset.headers()["content-type"]).toContain("image/png");

  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText("Open one of the first-run setup links")).toBeVisible();
  await expect(page.getByLabel("Setup token")).toHaveCount(0);
  await expect(page.getByLabel("Owner username")).toHaveCount(0);

  await page.goto(`/api/setup/claim?token=${encodeURIComponent(token)}`);
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByLabel("Setup token")).toHaveCount(0);
  await expect(page.getByLabel("Owner username")).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle color theme" })).toBeVisible();
  await expect(page.locator("[data-brand-mark]")).toBeVisible();
  const lightLogoSource = await page.locator("[data-brand-mark]").getAttribute("src");
  expect(lightLogoSource).toContain("nixship-mark.png");
  expect(
    await page
      .locator("[data-brand-mark]")
      .evaluate((element) => (element as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);

  const labels = ["Owner username", "Password"];
  const boxes = await Promise.all(labels.map((label) => page.getByLabel(label).boundingBox()));
  expect(boxes.every(Boolean)).toBe(true);
  for (const box of boxes.slice(1)) {
    expect(Math.abs((box?.x ?? 0) - (boxes[0]?.x ?? 0))).toBeLessThan(1);
    expect(Math.abs((box?.width ?? 0) - (boxes[0]?.width ?? 0))).toBeLessThan(1);
  }

  await page.evaluate(() => localStorage.setItem("platform-theme", "dracula"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  expect(await page.locator("[data-brand-mark]").getAttribute("src")).toBe(lightLogoSource);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  await page.getByRole("button", { name: "Toggle color theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cupcake");

  await page.setViewportSize({ width: 390, height: 844 });
  const authCard = await page.locator("main section").boundingBox();
  expect(authCard?.x).toBeGreaterThanOrEqual(16);
  expect((authCard?.x ?? 0) + (authCard?.width ?? 0)).toBeLessThanOrEqual(374);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByLabel("Owner username").fill("owner");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(page).toHaveURL(/\/apps$/);
  await expect(page.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle color theme" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import repository" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "New application" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect GitHub" })).toHaveCount(1);
  expect(fs.existsSync(tokenPath)).toBe(false);
  expect(
    await page.evaluate(async () => {
      const response = await fetch("/api/auth/me");
      return response.json();
    }),
  ).toMatchObject({
    ok: true,
    data: { user: { username: "owner", role: "owner" } },
  });

  await page.goto("/account");
  await page.getByLabel("Current password").fill("correct horse battery staple");
  await page.getByLabel("New password", { exact: true }).fill("new correct horse battery staple");
  await page.getByLabel("Confirm new password").fill("new correct horse battery staple");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(
    page.getByText("Password changed. Other signed-in sessions were logged out."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid username or password")).toBeVisible();
  await page.getByLabel("Password").fill("new correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/apps$/);

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const route of [
      "/apps",
      "/deployments",
      "/integrations/github",
      "/integrations/cloudflare",
      "/system",
      "/users",
      "/account",
    ]) {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("main .loading-spinner")).toHaveCount(0);
      await expect(page.locator('button[aria-label="Toggle color theme"]:visible')).toHaveCount(1);
      const overflow = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        elements: Array.from(document.querySelectorAll<HTMLElement>("body *"))
          .filter((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.right > document.documentElement.clientWidth + 1 || bounds.left < -1;
          })
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
          })),
      }));
      expect(
        overflow.scrollWidth,
        `${route} overflowed at ${viewport.width}x${viewport.height}: ${JSON.stringify(overflow.elements)}`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  for (const failureCase of [
    { route: "/apps", endpoint: "**/api/apps" },
    { route: "/integrations/github", endpoint: "**/api/github/status" },
    { route: "/integrations/cloudflare", endpoint: "**/api/cloudflare/status" },
    { route: "/system", endpoint: "**/api/system/status" },
  ]) {
    await page.route(failureCase.endpoint, async (route) => {
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          error: { code: "test_failure", message: "Injected load failure" },
        },
      });
    });
    await page.goto(failureCase.route);
    await expect(page.getByText("Injected load failure")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.locator("main .loading-spinner")).toHaveCount(0);
    await page.unroute(failureCase.endpoint);
  }

  await page.route("**/api/github/status", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        data: {
          connected: true,
          canManage: true,
          app: {
            installUrl: "https://github.com/apps/platform-test/installations/new",
          },
        },
      },
    });
  });
  await page.route("**/api/github/repositories", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        data: [
          {
            id: 1,
            full_name: "owner/alpha",
            clone_url: "https://github.com/owner/alpha.git",
            default_branch: "main",
            installation_id: 10,
            private: false,
          },
          {
            id: 2,
            full_name: "owner/beta",
            clone_url: "https://github.com/owner/beta.git",
            default_branch: "trunk",
            installation_id: 10,
            private: true,
          },
        ],
      },
    });
  });
  await page.goto("/apps");
  await page.getByRole("button", { name: "Import repository" }).click();
  await expect(page.getByRole("button", { name: "Public URL" })).toBeVisible();
  await page.getByRole("button", { name: "Public URL" }).click();
  await expect(page.getByLabel("Public GitHub repository URL")).toBeVisible();
  await page.getByRole("button", { name: "GitHub access" }).click();
  await page.getByLabel("Search GitHub repositories").fill("beta");
  await expect(page.getByRole("button", { name: /owner\/beta/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /owner\/alpha/ })).toHaveCount(0);
  await page.getByRole("button", { name: /owner\/beta/ }).click();
  await expect(page.getByRole("button", { name: /owner\/beta/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByLabel("Search GitHub repositories")).toBeVisible();
    const dialog = await page.getByRole("dialog").boundingBox();
    expect(dialog?.x).toBeGreaterThanOrEqual(0);
    expect((dialog?.x ?? 0) + (dialog?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  let environmentKeys: string[] = [];
  await page.route("**/api/apps/log-test/environment", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().postDataJSON()).toEqual({
      dotenv: `# Complete .env paste
PLAIN=alpha
SPACED="two words"
EQUALS=left=right
HASH='literal # hash'
EMPTY=
`,
      secret: true,
    });
    environmentKeys = ["EMPTY", "EQUALS", "HASH", "PLAIN", "SPACED"];
    await route.fulfill({
      json: {
        ok: true,
        data: environmentKeys.map((key) => ({
          key,
          secret: true,
          updatedAt: "2026-07-28T00:00:00.000Z",
        })),
      },
    });
  });
  await page.route("**/api/apps/log-test", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        data: {
          app: {
            id: "log-test",
            name: "Log test",
            slug: "log-test",
            kind: "web",
            repository_url: "https://github.com/example/log-test.git",
            branch: "main",
            flake_output: "default",
            auto_deploy: 1,
            desired_state: "running",
            restart_policy: "on-failure",
            health_path: "/",
            public_port: 10042,
            active_internal_port: null,
            active_deployment_id: null,
            updated_at: "2026-07-25T00:00:00.000Z",
          },
          operationalStatus: "failed",
          quickTunnel: null,
          accessLinks: [],
          domains: [],
          cloudflare: { configured: false, enabled: false, running: false, routes: [] },
          environment: environmentKeys.map((key) => ({
            key,
            secret: true,
            updatedAt: "2026-07-28T00:00:00.000Z",
          })),
          deployments: [
            {
              id: "deployment-log-test",
              state: "failed",
              commit_sha: null,
              requested_ref: "main",
              trigger: "manual",
              queued_at: "2026-07-25T00:00:00.000Z",
              activated_at: null,
              failure_message: "Git clone failed: authentication rejected",
              resource_confidence: "none",
            },
          ],
          metric: null,
        },
      },
    });
  });
  await page.route("**/api/deployments/deployment-log-test/logs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: log\ndata: {"stream":"deployment","text":"[deployment] failed · manual · main\\n[error] Git clone failed: authentication rejected\\n"}\n\n',
    });
  });
  await page.goto("/apps/log-test");
  await page.getByRole("tab", { name: "Environment" }).click();
  await page.getByLabel("Environment variables").fill(`# Complete .env paste
PLAIN=alpha
SPACED="two words"
EQUALS=left=right
HASH='literal # hash'
EMPTY=
`);
  await page.getByRole("button", { name: "Save secrets" }).click();
  for (const key of ["EMPTY", "EQUALS", "HASH", "PLAIN", "SPACED"]) {
    await expect(page.getByText(key, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("Environment variables")).toHaveValue("");

  await page.getByRole("tab", { name: "Deployments" }).click();
  await page.getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("tab", { name: "Logs" })).toBeChecked();
  await expect(page.locator("pre")).toContainText("[deployment] failed");
  await expect(page.locator("pre")).toContainText("authentication rejected");

  let cloudflareConfigured = false;
  await page.route("**/api/cloudflare/status", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        data: {
          configured: cloudflareConfigured,
          enabled: cloudflareConfigured,
          running: cloudflareConfigured,
          accountId: cloudflareConfigured ? "a".repeat(32) : null,
          tunnelId: cloudflareConfigured ? "tunnel-id" : null,
          dashboardHostname: cloudflareConfigured ? "console.example.com" : null,
          zones: [],
          routes: [],
        },
      },
    });
  });
  await page.route("**/api/cloudflare/configure", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      accountId: "a".repeat(32),
      apiToken: "restricted-cloudflare-token",
      tunnelName: "nixship",
      dashboardHostname: "console.example.com",
    });
    cloudflareConfigured = true;
    await route.fulfill({
      json: {
        ok: true,
        data: {
          configured: true,
          enabled: true,
          running: true,
          accountId: "a".repeat(32),
          tunnelId: "tunnel-id",
          dashboardHostname: "console.example.com",
          zones: [],
          routes: [],
        },
      },
    });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/integrations/cloudflare");
  await expect(page.getByRole("button", { name: "Connect Cloudflare" })).toBeVisible();
  await page.getByLabel("Account ID").fill("a".repeat(32));
  await page.getByLabel("API token").fill("restricted-cloudflare-token");
  await page.getByLabel("Dashboard hostname (optional)").fill("console.example.com");
  await page.getByRole("button", { name: "Connect Cloudflare" }).click();
  await expect(page.getByRole("heading", { name: "Persistent tunnel" })).toBeVisible();
  await expect(page.getByText("Restricted API token")).toBeVisible();
  await expect(page.getByLabel("Dashboard hostname (optional)")).toHaveValue("console.example.com");
  const cloudflareDimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(cloudflareDimensions.scrollWidth).toBeLessThanOrEqual(
    cloudflareDimensions.clientWidth + 1,
  );
  await page.setViewportSize({ width: 1280, height: 720 });

  const rejectedOrigin = await page.request.post("/api/users", {
    headers: { origin: "https://attacker.invalid" },
    data: { username: "blocked", password: "blocked-password", role: "viewer" },
  });
  expect(rejectedOrigin.status()).toBe(403);

  await page.goto("/users");
  await page.getByLabel("Username").fill("viewer");
  await page.getByLabel("Temporary password").fill("viewer password 123");
  await page.getByLabel("Role").selectOption("viewer");
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("cell", { name: "viewer" }).first()).toBeVisible();

  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto("/login");
  await viewerPage.getByLabel("Username").fill("viewer");
  await viewerPage.getByLabel("Password").fill("viewer password 123");
  await viewerPage.getByRole("button", { name: "Sign in" }).click();
  await expect(viewerPage).toHaveURL(/\/apps$/);
  await expect(viewerPage.getByRole("button", { name: "Connect GitHub" })).toHaveCount(0);

  await viewerPage.goto("/users");
  await expect(viewerPage).toHaveURL(/\/apps$/);
  const viewerMutation = await viewerPage.evaluate(async () => {
    const response = await fetch("/api/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Forbidden",
        repositoryUrl: "https://github.com/example/forbidden.git",
      }),
    });
    return response.status;
  });
  expect(viewerMutation).toBe(403);
  await viewerContext.close();
});
