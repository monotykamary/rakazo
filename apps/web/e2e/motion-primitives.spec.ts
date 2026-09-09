import { expect, test } from "@playwright/test";

test("reduced motion settles an already running spring", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/spring-motion.html");
  const spring = page.getByTestId("spring");
  await expect
    .poll(() => spring.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(316);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const widths = await spring.evaluate(async (element) => {
    await new Promise(requestAnimationFrame);
    const first = element.getBoundingClientRect().width;
    await new Promise(requestAnimationFrame);
    return [first, element.getBoundingClientRect().width];
  });
  expect(widths).toEqual([0, 0]);
  await expect(page.getByRole("button", { name: "Content", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle", exact: true }).click();
  await expect
    .poll(() => spring.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(316);
});
