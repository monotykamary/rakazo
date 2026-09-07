import { expect, test } from "@playwright/test";
import { expectAlignedControls } from "../../../packages/testkit/src/playwright-layout";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

// Normal CI stack: exercise the mounted app screens, not fixture-only chrome.
test("thread queue, retained Flow, and routing settings screens", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Queue Screens ${stamp}`;
  await signup(page, `queue-screens-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await expect(page.getByRole("button", { name: /^Queue ·/ })).toHaveCount(0);
  await expect(page.getByText("Paused", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "app-calm-empty-thread");
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("menuitem", { name: "Queue", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Queue", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "app-empty-queue-discovered");
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  if (await pause.isVisible()) await pause.click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Queued message", exact: true })
    .fill("Review the retained work");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  await expect(page.locator("[data-row-id]")).toContainText("Review the retained work");
  await captureScreenshot(page, testInfo, "app-thread-queue");
  await page.keyboard.press("Escape");

  // Two real runs exercise the selector without depending on queued-work placement.
  const botId = activeBotId(page);
  await page.getByPlaceholder(/^Message /).fill("Review the build");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      async () => {
        const { messages } = await rpc<{
          messages: Array<{ role: string; runId?: string | null }>;
        }>(page, "threads/messages", { botId });
        const runId = messages.find((message) => message.role === "bot" && message.runId)?.runId;
        if (!runId) return false;
        const { events } = await rpc<{ events: Array<{ type: string }> }>(
          page,
          "execution/inspect",
          { runId, limit: 200 },
        );
        return events.some((event) => event.type === "run.completed");
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // The deterministic CI runtime retains this failure; inspect real persisted evidence.
  await page.getByPlaceholder(/^Message /).fill("fail this run");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("composer-error")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("menuitem", { name: "Execution", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("run.failed", { exact: false })).toBeVisible();
  const inspector = page.getByRole("dialog", { name: "Execution", exact: true });
  const runSelect = inspector.getByRole("combobox", { name: "Run", exact: true });
  const flowButton = inspector.getByRole("button", { name: "Flow", exact: true });
  await expectAlignedControls(runSelect, flowButton);
  await flowButton.click();
  const outline = inspector.getByTestId("execution-flow");
  await expect(outline.locator("[data-flow-node]").first()).toBeVisible();
  await expect(outline.getByRole("region", { name: "Evidence", exact: true })).toHaveCount(0);
  await expect(outline).not.toContainText("run:");
  await captureScreenshot(page, testInfo, "app-execution-flow");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectAlignedControls(runSelect, flowButton);
  await expect
    .poll(() =>
      outline.evaluate((element) =>
        Array.from(element.querySelectorAll("*")).every(
          (item) => item.scrollWidth <= item.clientWidth + 1,
        ),
      ),
    )
    .toBe(true);
  await captureScreenshot(page, testInfo, "app-execution-flow-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");

  await rpc(page, "models/connect", {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:8090/v1",
    modelId: "fixture-model",
  });
  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByPlaceholder("Search providers").fill("openai-compatible");
  await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
  await page.getByRole("button", { name: "Rotation and fallback", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Pool model" })).toHaveValue("fixture-model");
  await captureScreenshot(page, testInfo, "app-model-routing");
});
