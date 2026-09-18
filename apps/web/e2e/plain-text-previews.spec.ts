import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("sidebar previews show plain text while messages retain Markdown", async ({
  page,
}, testInfo) => {
  await signup(page, `plain-preview-${Date.now()}@rakazo.test`, "password12", "Preview Test");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "threads/send", { botId, text: "**Projects-CoS** is ready for _review_." });
  const snapshot = await rpc<{
    messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
  }>(page, "threads/get", { botId });
  expect(
    snapshot.messages.some((message) =>
      message.blocks.some(
        (block) =>
          block.kind === "text" && block.text === "**Projects-CoS** is ready for _review_.",
      ),
    ),
  ).toBe(true);
  await page.reload();
  const bot = page.locator(`[data-roster-bot-id="${botId}"]`);
  await expect(bot).toContainText("Projects-CoS");
  await expect(bot).not.toContainText("**Projects-CoS**");
  await expect(bot).not.toContainText("_review_");
  await captureScreenshot(page, testInfo, "plain-text-sidebar-preview");
});
