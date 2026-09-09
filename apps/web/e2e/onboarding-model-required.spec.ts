import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("Pi onboarding never requires Rakazo model credentials", async ({ page }, testInfo) => {
  const calls: string[] = [];
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    await route.fulfill({
      json: {
        json:
          path === "/rpc/me" ? { hasOnboarded: false, needsModel: true } : { id: "bot-fixture" },
      },
    });
  });
  await page.goto("/e2e/fixtures/pi-models.html?onboarding");
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect a model" })).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill("First bot");
  await captureScreenshot(page, testInfo, "pi-onboarding-no-credentials");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => calls.includes("/rpc/bots/create")).toBe(true);
  expect(calls.some((path) => path.startsWith("/rpc/models/"))).toBe(false);
});
