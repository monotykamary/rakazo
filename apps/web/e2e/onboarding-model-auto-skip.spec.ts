import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding opens the bot form with a Pi default and retains return navigation", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", (route) =>
    route.fulfill({ json: { json: { hasOnboarded: true, needsModel: false } } }),
  );
  await page.goto("/e2e/fixtures/pi-models.html?onboarding");
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect a model" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Skip for now" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByLabel("Name", { exact: true }).fill("   ");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByLabel("Name", { exact: true }).fill("First bot");
  await page.getByLabel("Title", { exact: true }).fill("Research");
  await page.getByLabel("Description", { exact: true }).fill("Summarize findings");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "onboarding-model-auto-skip");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test("signed-up users reach Pi onboarding without an app-managed model", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  const stamp = Date.now();
  await signup(page, `pi-onboarding-${stamp}@rakazo.test`, "password12", "Pi onboarding");
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect a model" })).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill("Research bot");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/[^/]+$/);
  await captureScreenshot(page, testInfo, "pi-onboarding-created-bot");
});
