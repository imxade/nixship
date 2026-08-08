import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("auth lifecycle works through native POST forms without JavaScript", async ({ page }) => {
  const baseDataDirectory = process.env.E2E_DATA_DIR || path.join(process.cwd(), ".e2e-data");
  const tokenPath = path.resolve(`${baseDataDirectory}-native`, "setup-token.txt");
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const leakedCredentialUrls: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.searchParams.has("password") || url.searchParams.has("currentPassword")) {
      leakedCredentialUrls.push(url.toString());
    }
  });

  await page.goto(`/api/setup/claim?token=${encodeURIComponent(token)}`);
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByLabel("Owner username")).toBeVisible();
  await page.getByLabel("Owner username").fill("native-owner");
  await page.getByLabel("Password").fill("native original password");
  await page.getByRole("button", { name: "Create owner account" }).click();

  await expect(page).toHaveURL(/\/apps$/);
  await expect(page.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
  expect(fs.existsSync(tokenPath)).toBe(false);

  await page.goto("/account");
  await page.getByLabel("Current password").fill("native original password");
  await page.getByLabel("New password", { exact: true }).fill("native replacement password");
  await page.getByLabel("Confirm new password").fill("native replacement password");
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page).toHaveURL(/\/account\?passwordChanged=1$/);
  await expect(
    page.getByText("Password changed. Other signed-in sessions were logged out."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Username").fill("native-owner");
  await page.getByLabel("Password").fill("native original password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login\?error=invalid_credentials$/);
  await expect(page.getByText("Invalid username or password")).toBeVisible();

  await page.getByLabel("Username").fill("native-owner");
  await page.getByLabel("Password").fill("native replacement password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/apps$/);
  expect(leakedCredentialUrls).toEqual([]);
});
