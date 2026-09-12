import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.describe.configure({ mode: "serial" });

test("agent-attached files appear as downloadable cards", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `artifact-card-${stamp}@rakazo.test`, "password12", "Artifact Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("write notes/result.txt and attach it to the thread");
  await page.keyboard.press("Enter");

  // Scope to ArtifactFileCard text (name + mime); sidebar bot status can also
  // include the prompt path notes/result.txt once status syncs immediately.
  const fileCard = page.getByRole("button", { name: /result\.txt text\/plain/ });
  await expect(fileCard).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "current-file-card");

  const downloadPromise = page.waitForEvent("download");
  await fileCard.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("result.txt");
});

test("agent-attached Markdown opens a rendered preview and can be downloaded", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `markdown-preview-${stamp}@rakazo.test`, "password12", "Markdown Preview");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(
    "write path notes/preview.md and attach it to the thread says # Project preview",
  );
  await page.keyboard.press("Enter");

  const previewButton = page.getByRole("button", { name: "Preview preview.md" });
  await expect(previewButton).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "markdown-file-card");
  await previewButton.click();

  const dialog = page.getByRole("dialog", { name: "preview.md" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Project preview" })).toBeVisible();
  const closeButton = dialog.getByRole("button", { name: "Close preview" });
  const downloadButton = dialog.getByRole("button", { name: "Download preview.md" });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(downloadButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(closeButton).toBeFocused();
  await captureScreenshot(page, testInfo, "markdown-preview-open");

  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("preview.md");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(previewButton).toBeFocused();
});

test("consecutive images render as a fanned stack", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `image-fan-${stamp}@rakazo.test`, "password12", "Image Fan");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const artifactIds: string[] = [];
  for (const name of ["one.png", "two.png", "three.png"]) {
    const artifact = await rpc<{ id: string }>(page, "artifacts/create", {
      botId,
      name,
      mimeType: "image/png",
      contentBase64: TINY_PNG,
    });
    artifactIds.push(artifact.id);
  }
  await rpc(page, "threads/send", {
    botId,
    text: "Here's the latest output:",
    artifactIds,
  });
  const fan = page.getByTestId("artifact-image-fan");
  await expect(fan).toBeVisible({ timeout: 20_000 });
  await expect(fan).toHaveAttribute("aria-label", "3 images");
  await expect(fan.locator("img")).toHaveCount(3);
  await captureScreenshot(page, testInfo, "image-fan");
  await fan.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Previous image" })).toBeVisible();
  await captureScreenshot(page, testInfo, "image-fan-open");
});
