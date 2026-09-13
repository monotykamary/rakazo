import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

test("chat folds tool activity into a mini-avatar steps row", async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/e2e/fixtures/hitl-prompts.html");
    await expect(page.getByTestId("tool-steps").first()).toBeVisible();
    await expect(page.getByTestId("tool-activity")).toHaveCount(0);
    await expect(page.getByText("Working…")).toHaveCount(0);
    await expect(page.getByText("Done", { exact: true })).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `steps-${viewport.name}`);
  }
});
