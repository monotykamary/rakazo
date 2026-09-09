import { expect, test } from "@playwright/test";

test("Pi inventory keyboard search matches provider and custom model id", async ({ page }) => {
  await page.route("**/rpc/models/runtime", (route) =>
    route.fulfill({
      json: {
        json: {
          catalog: [
            { provider: "extension-provider", id: "custom/model-v3", label: "Custom", billing: "" },
            { provider: "other", id: "other", label: "Other", billing: "" },
          ],
          profileDefault: null,
          current: null,
          selection: null,
          availability: { status: "available", error: null },
        },
      },
    }),
  );
  await page.goto("/e2e/fixtures/pi-models.html");
  const search = page.getByRole("combobox", { name: "Search models" });
  await search.fill("extension-provider");
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.getByTestId("selected-model")).toHaveCount(0);
  await search.fill("custom/model-v3");
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.fill("not-in-pi");
  await expect(page.getByText("No matching models")).toBeVisible();
  await expect(page.getByTestId("selected-model")).toHaveCount(0);
});
