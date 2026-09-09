import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`sidebar motion and persistence (${reducedMotion})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion });
    await signup(
      page,
      `sidebar-motion-${reducedMotion}-${Date.now()}@rakazo.test`,
      "password12",
      "Test User",
    );
    await completeOnboarding(page);
    await page.goto("/app");
    await page.waitForURL(/\/app\/[^/]+$/);
    const sidebar = page.getByTestId("bots-sidebar");
    const edge = page.getByTestId("bots-sidebar-edge");
    const width = () => sidebar.evaluate((element) => element.getBoundingClientRect().width);
    await expect.poll(width).toBe(316);
    await page.getByTestId("minimize-bots-sidebar").click();
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(edge).toBeFocused();
    await expect.poll(width).toBe(0);
    await page.keyboard.press("Tab");
    expect(await sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(
      false,
    );
    await captureScreenshot(page, testInfo, `sidebar-collapsed-${reducedMotion}`);
    await page.reload();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await expect.poll(width).toBe(0);
    await edge.focus();
    await page.keyboard.press("Enter");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    await expect.poll(width).toBe(316);
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await captureScreenshot(page, testInfo, `sidebar-expanded-${reducedMotion}`);
    if (reducedMotion === "no-preference") {
      await page.getByTestId("minimize-bots-sidebar").click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      const settled = await sidebar.evaluate(async (element) => {
        await new Promise(requestAnimationFrame);
        const first = element.getBoundingClientRect().width;
        await new Promise(requestAnimationFrame);
        return [first, element.getBoundingClientRect().width];
      });
      expect(settled).toEqual([0, 0]);
    }
    if (reducedMotion === "reduce") {
      const frames = await sidebar.evaluate(async (element) => {
        const toggle = document.querySelector<HTMLButtonElement>(
          '[data-testid="minimize-bots-sidebar"]',
        )!;
        toggle.click();
        await new Promise(requestAnimationFrame);
        const first = element.getBoundingClientRect().width;
        await new Promise(requestAnimationFrame);
        return [first, element.getBoundingClientRect().width];
      });
      expect(frames).toEqual([0, 0]);
    }
  });
}
