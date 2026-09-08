import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createBotFromPicker, signup } from "./helpers";

const machine = {
  id: "m1",
  name: "workshop",
  status: "online",
  version: "1.0.0",
  lastSeenAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

function fulfillJson(route: { fulfill: (options: { json: unknown }) => unknown }, data: unknown) {
  return route.fulfill({ json: { json: data } });
}

async function mockMachines(page: Page, options: { assigned: () => string | null }) {
  await page.route("**/rpc/machines/list", (route) => fulfillJson(route, [machine]));
  await page.route("**/rpc/machines/assignment", (route) =>
    fulfillJson(route, {
      botId: "bot-deploy",
      machineId: options.assigned(),
      computerId: options.assigned() ? "computer-1" : null,
    }),
  );
  await page.route("**/rpc/machines/cancelPairing", (route) => fulfillJson(route, { ok: true }));
}

async function openBotSettings(page: Page, botName: string) {
  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  await page.getByText("Settings", { exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  await settings.getByText("Advanced").click();
  return settings;
}

test("bot settings expose machine placement without a repository picker", async ({
  page,
}, testInfo) => {
  let assigned: string | null = null;
  await mockMachines(page, { assigned: () => assigned });

  const stamp = Date.now();
  await signup(page, `bot-deploy-${stamp}@rakazo.test`, "password12", "Bot Deploy");
  await completeOnboarding(page);
  await page.goto("/app");
  await createBotFromPicker(page, { name: "Deploy Bot" });
  await expect(
    page.locator("aside").first().getByText("Deploy Bot", { exact: true }),
  ).toBeVisible();

  const settings = await openBotSettings(page, "Deploy Bot");
  const runsOn = settings.getByTestId("bot-runs-on");
  await expect(runsOn.getByText("Runs on")).toBeVisible();
  await expect(runsOn.getByTestId("runs-on-trigger")).toHaveText(/Default machine/);
  // The bot list and chat stay in place while settings are inspected.
  await expect(
    page.locator("aside").first().getByText("Deploy Bot", { exact: true }),
  ).toBeVisible();

  await runsOn.getByTestId("runs-on-trigger").click();
  const dialog = page.getByTestId("runs-on-dialog");
  await expect(dialog.getByTestId("runs-on-machine")).toHaveText(/workshop/);
  await expect(dialog.getByRole("button", { name: /Revoke workshop/ })).toBeVisible();
  await expect(dialog.getByText("Add machine")).toBeVisible();
  // Locally managed setup: say so plainly, once.
  await expect(dialog.getByTestId("runs-on-local-warning")).toBeVisible();
  // No repository selection anywhere in the flow.
  await expect(dialog.getByText("Repository")).toHaveCount(0);

  await dialog.getByText("Add machine").click();
  await page.getByTestId("runs-on-machine-name").fill("workshop-2");
  await page.route("**/rpc/machines/startPairing", (route) =>
    fulfillJson(route, {
      pairingId: "p1",
      code: "rk_p_TESTCODE123456",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }),
  );
  await dialog.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(dialog.getByTestId("runs-on-pairing-code")).toHaveText(/rk_p_/);
  await expect(dialog.getByText("Waiting for machine…")).toBeVisible();
  await expect(
    page.locator("aside").first().getByText("Deploy Bot", { exact: true }),
  ).toBeVisible();
  // Modal focus isolation hides background roles, not the visible bot sidebar.
  // Long pairing commands must fit at desktop and narrow-screen widths.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const dialogBounds = await dialog.boundingBox();
    const pairingBounds = await dialog.getByTestId("runs-on-pairing").boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(pairingBounds).not.toBeNull();
    expect(pairingBounds!.x).toBeGreaterThanOrEqual(dialogBounds!.x);
    expect(pairingBounds!.x + pairingBounds!.width).toBeLessThanOrEqual(
      dialogBounds!.x + dialogBounds!.width,
    );
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await captureScreenshot(page, testInfo, "33-bot-deployment-pairing");

  await dialog.getByRole("button", { name: "Cancel pairing" }).click();
  await expect(dialog.getByTestId("runs-on-machine")).toHaveText(/workshop/);

  await page.route("**/rpc/machines/assign", (route) => {
    assigned = "m1";
    return fulfillJson(route, {
      botId: "bot-deploy",
      machineId: assigned,
      computerId: "computer-1",
    });
  });
  await dialog.getByTestId("runs-on-machine").click();
  await expect(runsOn.getByTestId("runs-on-trigger")).toHaveText(/workshop/);
  await expect(
    page.locator("aside").first().getByText("Deploy Bot", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "34-bot-deployment-placed");
  await page.route("**/rpc/machines/assign", (route) => {
    assigned = null;
    return fulfillJson(route, { botId: "bot-deploy", machineId: null, computerId: null });
  });
  await dialog.getByTestId("runs-on-default").click();
  await expect(runsOn.getByTestId("runs-on-trigger")).toHaveText(/Default machine/);
});
