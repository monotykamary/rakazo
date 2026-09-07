import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("real routine update activity opens its right sidebar and survives reload", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `routine-activity-${Date.now()}@rakazo.test`,
    "password12",
    "Routine Activity",
  );
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Daily report",
    prompt: "Prepare the report",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: false,
  });
  await rpc(page, "routines/update", {
    routineId: routine.id,
    name: "Weekly report",
    prompt: "Prepare the weekly report",
  });
  const link = page.getByRole("button", { name: "Updated routine Weekly report", exact: true });
  await expect(link).toBeVisible();
  await expect(page.getByRole("button", { name: /^Queue ·/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "routine-activity-message");
  await link.click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "routine");
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Weekly report");
  await expect(page.locator("label:has-text('Instruction') textarea")).toHaveValue(
    "Prepare the weekly report",
  );
  await captureScreenshot(page, testInfo, "routine-activity-sidebar");
  await page.reload();
  await expect(link).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await link.click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "routine");
  await captureScreenshot(page, testInfo, "routine-activity-mobile-web");
});
