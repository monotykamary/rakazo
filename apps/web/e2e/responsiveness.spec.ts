import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  signup,
} from "./helpers";

test("slow thread reads retain navigation, mount once, and respect reduced motion", async ({
  page,
}, testInfo) => {
  await signup(page, `responsive-${Date.now()}@rakazo.test`, "password12", "Responsive Fixture");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const transcript = page.getByTestId("transcript");
  await expect(transcript).toHaveAttribute("aria-busy", "false");
  await createBotFromPicker(page);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect(transcript).toHaveAttribute("aria-busy", "false");
  await page.getByPlaceholder("Message New Bot").fill("Other thread marker");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(transcript).toContainText("Other thread marker");

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/threads/get", async (route) => {
    if (route.request().postDataJSON()?.json?.botId !== chiefId) return route.continue();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page
      .locator("aside")
      .first()
      .getByRole("button", { name: /^Chief/ })
      .click();
    await expect(transcript).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("thread-loading")).toBeVisible();
    await expect(transcript).not.toContainText("Other thread marker");
    await expect(page.locator("aside").first()).toBeVisible();
    await transcript.evaluate((element) => element.setAttribute("data-retained-probe", "yes"));
    await page.getByPlaceholder("Message Chief").fill("Draft while history loads");
    await captureScreenshot(page, testInfo, "thread-loading-navigation-retained");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page
        .getByTestId("thread-loading")
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    release();
    await expect(transcript).toHaveAttribute("aria-busy", "false");
    await expect(transcript).toHaveAttribute("data-retained-probe", "yes");
    await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toHaveValue(
      "Draft while history loads",
    );
    await expect(transcript).not.toContainText("Other thread marker");
    await expect(page.getByTestId("thread-loading")).toHaveCount(0);
    expect(await transcript.evaluate((element) => getComputedStyle(element).animationName)).toBe(
      "none",
    );
    await page.getByTestId("bot-settings-trigger").click();
    const panel = page.getByTestId("side-panel");
    await expect(panel).toHaveAttribute("data-panel", "settings");
    const transition = await panel.evaluate(
      (element) => getComputedStyle(element).transitionProperty,
    );
    expect(transition).not.toContain("width");
    expect(await panel.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
      "0s",
    );
    await captureScreenshot(page, testInfo, "thread-settings-reduced-motion");
  } finally {
    release();
  }
});

test("optional mention metadata waits for intent rather than competing with startup", async ({
  page,
}) => {
  await signup(page, `lazy-mentions-${Date.now()}@rakazo.test`, "password12", "Lazy Mentions");
  await completeOnboarding(page);
  let catalogRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/rpc/connections/catalog") catalogRequests++;
  });
  const skillsLoaded = page.waitForResponse((response) =>
    response.url().includes("/rpc/agentSkills/list"),
  );
  await page.reload();
  await skillsLoaded;
  await expect(page.getByTestId("transcript")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(catalogRequests).toBe(0);
  const composer = page.getByRole("combobox", { name: "Message Chief", exact: true });
  await composer.fill("@");
  await expect.poll(() => catalogRequests).toBe(1);
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.fill("@Ch");
  expect(catalogRequests).toBe(1);
});
