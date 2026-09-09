import { expect, test } from "@playwright/test";
import { expectAlignedControls } from "../../../packages/testkit/src/playwright-layout";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

// Normal CI stack: exercise the mounted app screens, not fixture-only chrome.
test("thread queue, retained Flow, and Pi inventory screens", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Queue Screens ${stamp}`;
  await signup(page, `queue-screens-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await expect(page.getByTestId("thread-queue")).not.toBeVisible();
  await expect(page.getByText("Add queued message", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Queued message" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "app-calm-empty-thread");

  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill("Review the retained work");
  await page.locator('input[type="file"]').setInputFiles({
    name: "review-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("offline fixture"),
  });
  await expect(page.getByRole("button", { name: "Remove review-notes.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Choose message action" }).click();
  await page.getByRole("menuitem", { name: "Queue", exact: true }).click();
  await expect(page.locator("[data-row-id]")).toContainText("Review the retained work");
  await expect(page.locator("[data-row-id]")).toContainText("review-notes.txt");
  await expect(page.getByRole("button", { name: "Queue, 1 message" })).toBeVisible();
  // Before the first run there is no authorized project placement to drain into.
  await page.getByLabel("Queue options").click();
  await expect(page.getByRole("menuitem", { name: "Drain all", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page
    .locator("[data-row-id]")
    .getByLabel(/Options for queued message:/)
    .click();
  await expect(page.getByRole("menuitem", { name: "Use current project" })).toBeVisible();
  await page.keyboard.press("Escape");
  await captureScreenshot(page, testInfo, "app-thread-queue");
  await page.getByRole("button", { name: "Queue, 1 message" }).click();

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
  await page.getByRole("button", { name: "Inspect failed run", exact: true }).click();
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

  // Exercise the real mounted overlay with an offline Pi inventory, never a host profile.
  await page.route("**/rpc/models/runtime", (route) =>
    route.fulfill({
      json: {
        json: {
          catalog: [
            { provider: "custom-extension", id: "research-model", label: "Research", billing: "" },
          ],
          profileDefault: {
            provider: "custom-extension",
            modelId: "research-model",
            thinkingLevel: null,
          },
          current: null,
          selection: null,
          availability: { status: "available", error: null },
        },
      },
    }),
  );
  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill("research-model");
  await page.getByText("Pi profile default", { exact: true }).click();
  await expect(page.getByTestId("pi-profile-default")).toContainText(
    "custom-extension/research-model",
  );
  await expect(page.getByRole("option")).toContainText("custom-extension");
  await expect(
    page.getByRole("button", { name: "Rotation and fallback", exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "app-pi-model-inventory");
});
