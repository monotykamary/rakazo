import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createBotFromPicker, signup } from "./helpers";

function fulfillJson(route: { fulfill: (options: { json: unknown }) => unknown }, data: unknown) {
  return route.fulfill({ json: { json: data } });
}

const services = [
  {
    name: "web",
    status: "running",
    pid: 42,
    ports: [5173],
    keepAlive: false,
    cwd: "/home/rakazo/bots/b1/app",
  },
];

async function mockServices(page: Page, options: { list?: unknown } = {}) {
  await page.route("**/rpc/services/list", (route) =>
    fulfillJson(route, { supported: true, services: options.list ?? services }),
  );
  await page.route("**/rpc/services/stop", (route) => fulfillJson(route, { ok: true }));
  await page.route("**/rpc/services/restart", (route) => fulfillJson(route, { ok: true }));
  await page.route("**/rpc/services/remove", (route) => fulfillJson(route, { ok: true }));
  await page.route("**/rpc/services/declare", (route) => fulfillJson(route, { ok: true }));
  await page.route("**/rpc/services/changes", (route) =>
    fulfillJson(route, {
      branch: "main",
      status: " M src/app.ts\n",
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      truncated: false,
    }),
  );
  await page.route("**/rpc/services/previewUrl", (route) =>
    fulfillJson(route, {
      path: "/api/preview/v1.mock.sig/",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
  );
  await page.route("**/api/preview/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body><h1>Dev server</h1></body></html>",
    }),
  );
}

async function openBotSettingsAdvanced(page: Page, botName: string) {
  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  await page.getByText("Settings", { exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await settings.getByText("Advanced").click();
  return settings;
}

test("bot settings expose supervised services with preview and changes", async ({
  page,
}, testInfo) => {
  await mockServices(page);
  const stamp = Date.now();
  await signup(page, `bot-services-${stamp}@rakazo.test`, "password12", "Bot Services");
  await completeOnboarding(page);
  await page.goto("/app");
  await createBotFromPicker(page, { name: "Services Bot" });

  const settings = await openBotSettingsAdvanced(page, "Services Bot");
  const panel = settings.getByTestId("bot-services");
  await expect(panel.getByText("Services")).toBeVisible();
  const row = panel.getByTestId("bot-service");
  await expect(row).toHaveText(/web/);
  // The bot sidebar and chat stay in place while services are inspected.
  await expect(
    page
      .locator("aside")
      .first()
      .getByRole("button", { name: /^Services Bot/ }),
  ).toBeVisible();

  await row.getByRole("button", { name: "Preview" }).click();
  const frame = page.frameLocator("iframe[title*='preview']");
  await expect(frame.getByText("Dev server")).toBeVisible();
  await panel.getByRole("button", { name: "Close preview" }).click();

  await row.getByRole("button", { name: "Changes" }).click();
  await expect(settings.getByTestId("bot-service-changes")).toContainText(" M src/app.ts");
  await expect(settings.getByTestId("bot-service-changes")).toContainText("main");

  await row.getByRole("button", { name: "Stop web" }).click();
  await expect(row).toBeVisible();

  await captureScreenshot(page, testInfo, "35-bot-services");
});
