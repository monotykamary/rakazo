import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  rpc,
  signup,
} from "./helpers";

test("closing a client keeps the server run alive for another client", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    process.env.SANDBOX_PROVIDER && process.env.SANDBOX_PROVIDER !== "fake",
    "Deterministic scripted-runtime continuity fixture",
  );
  await signup(page, `continuity-${Date.now()}@rakazo.test`, "password12", "Continuity fixture");
  await completeOnboarding(page);
  await createBotFromPicker(page, { name: "Continuity Bot" });
  const botId = activeBotId(page);
  const origin = new URL(page.url()).origin;
  await page
    .getByPlaceholder("Message Continuity Bot")
    .fill("Keep working until I stop you; continuity marker.");
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/threads/send") && response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  const response = await sent;
  expect(response.ok()).toBe(true);
  const {
    json: { runId },
  } = (await response.json()) as { json: { runId: string } };
  type Snapshot = { run: { id: string; status: string } | null; messages: unknown[] };
  await expect
    .poll(async () => (await rpc<Snapshot>(page, "threads/get", { botId })).run)
    .toMatchObject({ id: runId, status: "running" });
  const storageState = await page.context().storageState();
  await page.context().close();

  const nextClient = await browser.newContext({ baseURL: origin, storageState });
  const nextPage = await nextClient.newPage();
  try {
    await nextPage.goto(`/app/${botId}`);
    await expect(nextPage.getByPlaceholder("Message Continuity Bot")).toBeVisible();
    await expect
      .poll(async () => (await rpc<Snapshot>(nextPage, "threads/get", { botId })).run)
      .toMatchObject({ id: runId, status: "running" });
    await expect(
      nextPage
        .getByTestId("message-user-bubble")
        .filter({ hasText: "Keep working until I stop you; continuity marker." }),
    ).toBeVisible();
    await captureScreenshot(nextPage, testInfo, "36-bot-client-continuation");
    await rpc(nextPage, "threads/stop", { botId });
    await expect
      .poll(async () => (await rpc<Snapshot>(nextPage, "threads/get", { botId })).run)
      .toBeNull();
    await nextPage
      .getByPlaceholder("Message Continuity Bot")
      .fill("Continue here with a follow-up.");
    await nextPage.keyboard.press("Enter");
    await expect(
      nextPage
        .getByTestId("message-user-bubble")
        .filter({ hasText: "Continue here with a follow-up." }),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const snapshot = await rpc<Snapshot>(nextPage, "threads/get", { botId });
        return (
          snapshot.run === null &&
          JSON.stringify(snapshot.messages).includes("done. i handled: Continue here")
        );
      })
      .toBe(true);
    expect(activeBotId(nextPage)).toBe(botId);
  } finally {
    await rpc(nextPage, "threads/stop", { botId }).catch(() => undefined);
    await nextClient.close();
  }
});
