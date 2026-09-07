import { expect, type Locator } from "@playwright/test";

export async function expectAlignedControls(first: Locator, second: Locator) {
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
      return a && b ? { height: a.height - b.height, top: a.y - b.y } : null;
    })
    .toEqual({ height: 0, top: 0 });
  const typography = (element: Element) => {
    const style = getComputedStyle(element);
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily };
  };
  expect(await second.evaluate(typography)).toEqual(await first.evaluate(typography));
}
