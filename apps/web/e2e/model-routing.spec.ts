import { expect, test } from "@playwright/test";
import { type ModelRouting, ModelRoutingSchema } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

test("advanced model rotation and explicit fallback persist through the real RPC client", async ({
  page,
}, testInfo) => {
  let routing: ModelRouting | null = null;
  let reads = 0;
  let writes = 0;
  await page.route("**/rpc/models/getRouting", async (route) => {
    reads++;
    await route.fulfill({ json: { json: routing } });
  });
  await page.route("**/rpc/models/setRouting", async (route) => {
    const input = route.request().postDataJSON().json;
    expect(input.credentialId).toBe("primary");
    routing = ModelRoutingSchema.nullable().parse(input.routing);
    writes++;
    await route.fulfill({ json: { json: routing } });
  });
  await page.goto("/e2e/fixtures/model-routing.html");
  await expect(page.getByRole("textbox", { name: "Pool model" })).toHaveCount(0);
  expect(reads).toBe(0);
  await page.getByRole("button", { name: "Rotation and fallback" }).click();
  await expect(page.getByRole("textbox", { name: "Pool model" })).toHaveValue("model-a");
  await page.getByRole("combobox", { name: "Rotation", exact: true }).selectOption("round-robin");
  await page.getByRole("checkbox", { name: "Secondary" }).check();
  await expect(page.getByRole("checkbox", { name: "Primary" })).toBeDisabled();
  await page.getByRole("combobox", { name: "Fallback connection" }).selectOption("fallback");
  await page.getByRole("combobox", { name: "Fallback model" }).fill("model-b");
  await page.getByRole("button", { name: "Add fallback" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  expect(routing).toEqual({
    version: 1,
    strategy: "round-robin",
    credentialIds: ["primary", "secondary"],
    modelId: "model-a",
    fallbacks: [{ credentialId: "fallback", modelId: "model-b" }],
  });
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await captureScreenshot(page, testInfo, "model-routing-advanced");
  await page.getByRole("button", { name: "Rotation and fallback" }).click();
  await page.getByRole("button", { name: "Rotation and fallback" }).click();
  await expect(page.getByRole("combobox", { name: "Rotation", exact: true })).toHaveValue(
    "round-robin",
  );
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(() => writes).toBe(2);
  expect(routing).toBeNull();
});
