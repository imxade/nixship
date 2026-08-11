import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("qwerty123456");
  await page.getByLabel("Password").fill("qwerty123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/apps$/);
});

test("assistant distinguishes answers, secure input, and immutable plans", async ({ page }) => {
  await page.getByRole("button", { name: "Open Nix Ship assistant" }).click();
  await expect(page.getByRole("heading", { name: "Nix Ship assistant" })).toBeVisible();

  await page.getByPlaceholder("Ask Nix Ship…").fill("Can you answer a question?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByText("Nix Ship can answer questions without creating an approval plan."),
  ).toBeVisible();
  await expect(page.getByText("Approval required")).toHaveCount(0);

  await page.getByPlaceholder("Ask Nix Ship…").fill("Request secure input for a provider key");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Secure input" })).toBeVisible();
  await expect(page.getByLabel("Provider API key")).toHaveAttribute("type", "password");

  await page.getByPlaceholder("Ask Nix Ship…").fill("Set the active deployment limit to 2");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Approval required" })).toBeVisible();
  await expect(page.getByText("system.updateSettings")).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const response = await fetch("/api/system/settings");
      return response.json();
    }),
  ).toMatchObject({ ok: true, data: { activeDeploymentLimit: 1 } });
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("rejected", { exact: true })).toBeVisible();
});

test("assistant drawer is usable as a mobile full-height sheet", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "Open Nix Ship assistant" }).click();
  const drawer = page.getByLabel("Nix Ship assistant");
  await expect(drawer).toBeVisible();
  const bounds = await drawer.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect(bounds?.width).toBeLessThanOrEqual(320);
  expect(bounds?.height).toBe(568);
  await expect(page.getByRole("button", { name: /Model:/ })).toBeVisible();
});
