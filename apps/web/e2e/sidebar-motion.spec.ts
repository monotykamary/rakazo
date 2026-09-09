import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`sidebar motion and persistence (${reducedMotion})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion, colorScheme: "dark" });
    await signup(
      page,
      `sidebar-motion-${reducedMotion}-${Date.now()}@rakazo.test`,
      "password12",
      "Test User",
    );
    await completeOnboarding(page);
    const sidebar = page.getByTestId("bots-sidebar");
    const edge = page.getByTestId("bots-sidebar-edge");
    const width = () => sidebar.evaluate((element) => element.getBoundingClientRect().width);
    await expect.poll(width).toBe(316);
    await page.getByTestId("user-menu-trigger").click();
    const menu = page.getByTestId("account-menu");
    await expect(menu).toBeVisible();
    await menu.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    const columns = [];
    for (const name of ["Settings", "Models", "Memory", "Voice", "Usage", "Log out"]) {
      const button = menu.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
      columns.push(
        await button.evaluate((element) => {
          const icon = element.querySelector("svg")!.getBoundingClientRect();
          const text = [...element.childNodes].find(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          )!;
          const range = document.createRange();
          range.selectNode(text);
          return {
            iconX: icon.x,
            width: icon.width,
            height: icon.height,
            labelX: range.getBoundingClientRect().x,
          };
        }),
      );
    }
    for (const column of columns) expect(column).toEqual({ ...columns[0], width: 16, height: 16 });
    await captureScreenshot(page, testInfo, `sidebar-account-menu-${reducedMotion}`);
    await page.keyboard.press("Escape");
    await page.getByTestId("minimize-bots-sidebar").click();
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(edge).toBeFocused();
    await expect.poll(width).toBe(0);
    await expect(edge).toHaveAccessibleName("Show bots");
    await expect(edge).toHaveAttribute("aria-expanded", "false");
    await expect(edge).toHaveAttribute("aria-controls", "bots-sidebar");
    await expect(edge.locator("svg")).toBeVisible();
    expect(
      await edge.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        blocked: Boolean(element.closest('[inert], [aria-hidden="true"]')),
      })),
    ).toEqual({ width: 40, blocked: false });
    await edge.click({ position: { x: 20, y: 24 } });
    await expect.poll(width).toBe(316);
    await page.getByTestId("minimize-bots-sidebar").focus();
    await page.keyboard.press("Space");
    await expect.poll(width).toBe(0);
    await expect(edge).toBeFocused();
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
    await page.setViewportSize({ width: 390, height: 844 });
    const backdrop = page.getByTestId("navigation-backdrop");
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(backdrop).toBeVisible();
    await expect
      .poll(() => backdrop.evaluate((element) => Number(getComputedStyle(element).opacity)))
      .toBe(1);
    const coverage = await backdrop.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const shell = document.querySelector('[data-testid="shell-root"]')!.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        fullWidth: rect.left === shell.left && rect.right === shell.right,
        fullHeight: rect.top === shell.top && rect.bottom === shell.bottom,
        blur: style.backdropFilter,
        background: style.backgroundColor,
      };
    });
    expect(coverage.fullWidth && coverage.fullHeight).toBe(true);
    expect(coverage.blur).toContain("blur(");
    expect(coverage.background).not.toBe("rgba(0, 0, 0, 0)");
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    await captureScreenshot(page, testInfo, `sidebar-mobile-backdrop-${reducedMotion}`);
    await backdrop.click({ position: { x: 375, y: 400 } });
    await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    await expect
      .poll(() => backdrop.evaluate((element) => Number(getComputedStyle(element).opacity)))
      .toBe(0);
    await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 });

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
