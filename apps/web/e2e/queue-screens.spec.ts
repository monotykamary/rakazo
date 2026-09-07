import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

// Normal CI stack: exercise the mounted app screens, not fixture-only chrome.
test("thread queue, retained Flow, and routing settings screens", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Queue Screens ${stamp}`;
  await signup(page, `queue-screens-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await page.getByRole("button", { name: /^Queue ·/ }).click();
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  if (await pause.isVisible()) await pause.click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Queued message", exact: true })
    .fill("Review the retained work");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  await expect(page.locator("[data-row-id]")).toContainText("Review the retained work");
  await captureScreenshot(page, testInfo, "app-thread-queue");

  // The deterministic CI runtime retains this failure; inspect real persisted evidence.
  await page.getByPlaceholder(/^Message /).fill("fail this run");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("composer-error")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Execution", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("run.failed", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await expect(page.locator("[data-flow-node]").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "app-execution-flow");
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
