import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("human-in-the-loop prompts use compact steps and action cards", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.goto("/e2e/fixtures/hitl-prompts.html", { waitUntil: "networkidle" });
  await expect(page.getByTestId("tool-steps").first()).toBeVisible();
  await expect(page.getByText("Sign in", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("3 steps", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("computer-takeover-card")).toBeVisible();
  await expect(page.getByTestId("computer-takeover-card").getByText("Take over")).toBeVisible();
  await expect(page.getByTestId("computer-takeover-card").getByText("Needs you")).toBeVisible();
  await expect(page.getByTestId("ask-card").getByText("Question")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send back" })).toBeVisible();
  await expect(page.getByTestId("outgoing-draft-card").getByText("New email")).toBeVisible();
  await expect(page.getByTestId("outgoing-draft-card").getByText("Ready to send")).toBeVisible();
  await page.getByTestId("tool-steps").first().click();
  await expect(page.getByText("Open Gmail", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await captureScreenshot(page, testInfo, "hitl-prompts-light");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await captureScreenshot(page, testInfo, "hitl-prompts-dark");
});
