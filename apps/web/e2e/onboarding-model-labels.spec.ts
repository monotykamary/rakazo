import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("Pi model labels and identities are displayed exactly as reported", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/models/runtime", (route) =>
    route.fulfill({
      json: {
        json: {
          catalog: [
            { provider: "extension", id: "model-stable", label: "Stable model", billing: "" },
            {
              provider: "extension",
              id: "model-alias",
              label: "Model (auto-updates)",
              billing: "",
            },
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
  const labels = await page.getByRole("option").allTextContents();
  expect(labels).toEqual([
    "Stable modelextension/model-stable",
    "Model (auto-updates)extension/model-alias",
  ]);
  await page.getByRole("option", { name: "Model (auto-updates) extension/model-alias" }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill("no-model-found");
  await expect(page.getByText("No matching models")).toBeVisible();
  await expect(page.getByTestId("selected-model")).toHaveCount(0);
  await expect(page.getByTestId("pi-profile-default")).toHaveText(
    "Pi profile default: Unavailable",
  );
  await captureScreenshot(page, testInfo, "pi-model-labels");
});
