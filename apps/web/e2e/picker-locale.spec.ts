import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("plus picker renders translated labels instead of message IDs", async ({ page }, testInfo) => {
  await signup(page, `picker-locale-${Date.now()}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("ui-locale-select").click();
  await settings.getByRole("option", { name: "Deutsch", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Einstellungen", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  await page.getByTestId("create-menu-trigger").click();
  const picker = page.getByTestId("bot-create-picker");
  await expect(picker.getByPlaceholder("Suchen", { exact: true })).toBeVisible();
  await expect(picker.getByRole("textbox", { name: "Suchen", exact: true })).toBeVisible();
  await expect(picker.getByText("An:", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "plus-picker-localized");
});
