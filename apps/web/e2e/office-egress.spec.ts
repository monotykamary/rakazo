import { expect, test } from "@playwright/test";

test("bot settings show desktop egress in the office list", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e/fixtures/office-egress.html");
  await expect(page.getByTestId("bot-settings")).toBeVisible();
  const manage = page.getByRole("button", { name: "Manage offices" });
  await expect(manage).toBeEnabled();
  await manage.click();
  await expect(page.getByTestId("runs-on-dialog")).toBeVisible();
  await expect(page.getByTestId("office-egress")).toBeVisible();
  await expect(page.getByText("Route egress through this desktop")).toBeVisible();
  await expect(page.getByTestId("office-egress-status")).toHaveText(
    "Connected — routing 2 connections (2 total this session).",
  );
  const screenshotPath = testInfo.outputPath("office-egress.png");
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: screenshotPath,
  });
  await testInfo.attach("office-egress", { contentType: "image/png", path: screenshotPath });
});
