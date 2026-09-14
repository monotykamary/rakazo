import { expect, test } from "@playwright/test";
import { BOT_OFFICE_PROMPTS } from "@rakazo/core";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  rpc,
  signup,
} from "./helpers";

for (const intent of ["link", "move"] as const) {
  test(`${intent} office sends an ordinary prompt to the selected bot`, async ({
    page,
  }, testInfo) => {
    await signup(page, `office-${intent}-${Date.now()}@rakazo.test`, "password12", "Office Test");
    await completeOnboarding(page);
    const otherBotId = activeBotId(page);
    await createBotFromPicker(page);
    const botId = activeBotId(page);
    expect(botId).not.toBe(otherBotId);

    // Simulate an existing assignment without mutating a machine or requiring a runner.
    await page.route("**/rpc/machines/assignment", (route) =>
      route.fulfill({
        json: { json: { botId, machineId: intent === "move" ? "office-fixture" : null } },
      }),
    );
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (/\/rpc\/machines\/(assign|startPairing|revoke)$/.test(new URL(request.url()).pathname)) {
        mutations.push(request.url());
      }
    });
    const composer = page.getByRole("combobox", { name: "Message New Bot", exact: true });
    await composer.fill("Keep this draft");
    await page.locator("main").getByRole("button", { name: "New Bot", exact: true }).click();
    const office = page.getByTestId("bot-runs-on");
    const action = office.getByRole("button", {
      name: intent === "move" ? "Move office" : "Link office",
      exact: true,
    });
    await expect(action).toBeEnabled();
    await expect(page.getByTestId("runs-on-dialog")).toBeHidden();
    await expect(office.getByText("Office", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `office-${intent}`);

    const sentRequest = page.waitForRequest("**/rpc/threads/send");
    await action.click();
    const input = (await sentRequest).postDataJSON().json;
    expect(input).toMatchObject({
      botId,
      text: BOT_OFFICE_PROMPTS[intent],
      clientNonce: expect.any(String),
    });
    expect(input.groupId).toBeUndefined();
    expect(input.artifactIds).toBeUndefined();
    expect(input.replyToMessageId).toBeUndefined();
    await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
    expect(activeBotId(page)).toBe(botId);
    await expect(composer).toHaveValue("Keep this draft");
    const hasPrompt = async (target: string) => {
      const history = await rpc<{
        messages: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }>;
      }>(page, "threads/messages", { botId: target });
      return history.messages.some(
        (message) =>
          message.role === "user" &&
          message.blocks.some(
            (block) => block.kind === "text" && block.text === BOT_OFFICE_PROMPTS[intent],
          ),
      );
    };
    await expect.poll(() => hasPrompt(botId)).toBe(true);
    expect(await hasPrompt(otherBotId)).toBe(false);
    expect(mutations).toEqual([]);
    await expect(
      page.locator("main").getByText(BOT_OFFICE_PROMPTS[intent], { exact: true }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, `office-${intent}-conversation`);
  });
}

test("manage offices shows desktop egress on the office list", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const unsupported = {
      phase: "unsupported",
      currentVersion: "0.1.0",
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    };
    (window as Window & { rakazoDesktop?: unknown }).rakazoDesktop = {
      platform: "darwin",
      window: {
        close: async () => undefined,
        minimize: async () => undefined,
        toggleMaximize: async () => undefined,
        state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
      },
      update: {
        state: async () => unsupported,
        check: async () => unsupported,
        download: async () => unsupported,
        install: async () => unsupported,
      },
      egress: {
        start: async () => undefined,
        stop: async () => undefined,
        state: async () => ({ connected: true, activeConnections: 2, sessionTotal: 2 }),
        onChange: () => () => undefined,
      },
      oauth: { onCallback: () => () => undefined },
    };
  });
  await page.route("**/rpc/machines/egress/get", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          hostConnected: true,
          activeConnections: 2,
          sessionTotal: 2,
        },
      },
    }),
  );
  await signup(page, `office-egress-${Date.now()}@rakazo.test`, "password12", "Office Test");
  await completeOnboarding(page);
  await createBotFromPicker(page);
  await page.locator("main").getByRole("button", { name: "New Bot", exact: true }).click();
  await page.getByRole("button", { name: "Manage offices" }).click();
  const dialog = page.getByTestId("runs-on-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("office-egress")).toBeVisible();
  await expect(page.getByText("Route egress through this desktop")).toBeVisible();
  await expect(page.getByTestId("office-egress-status")).toHaveText(
    "Connected — routing 2 connections (2 total this session).",
  );
  await captureScreenshot(page, testInfo, "office-egress");
});
