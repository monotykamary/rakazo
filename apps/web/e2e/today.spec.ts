import { expect, type Page, test } from "@playwright/test";
import type { QueueSnapshot } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

const emptyQueue: QueueSnapshot = {
  version: 1,
  sessionId: "session",
  revision: 0,
  rows: [
    {
      id: "row-1",
      sequence: 1,
      lane: "steer",
      text: "Keep Scout on the existing variants.",
      images: [],
    },
    {
      id: "row-2",
      sequence: 2,
      lane: "followUp",
      text: "Then open the PR.",
      images: [],
    },
  ],
  identity: { nextIdNumber: 3, nextSequence: 3 },
  uncertainRowIds: [],
  paused: false,
  errorHold: false,
  gracefulPausePending: false,
  modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
};

async function mockQueue(page: Page) {
  await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: emptyQueue } }));
  await page.route("**/rpc/queue/mutate", async (route) => {
    const input = route.request().postDataJSON().json as { requestId: string };
    await route.fulfill({
      json: { json: { version: 1, requestId: input.requestId, ok: true, snapshot: emptyQueue } },
    });
  });
}

test("thread chips and ops pills", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/today.html");
  await expect(page.getByTestId("scene-thread")).toBeVisible();
  await captureScreenshot(page, testInfo, "today-thread");
});

test("nested agent chat is view-only when finished", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/today.html?scene=readonly");
  await expect(page.getByTestId("peer-conversation-view")).toBeVisible();
  await expect(page.getByText("This chat is view-only")).toBeVisible();
  await captureScreenshot(page, testInfo, "today-nested-readonly");
});

test("nested agent chat can steer when live", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockQueue(page);
  await page.goto("/e2e/fixtures/today.html?scene=steer");
  const composer = page.getByRole("combobox", { name: "Message Scout" });
  await expect(page.getByTestId("composer-bar")).toBeVisible();
  await expect(page.getByText("This chat is view-only")).toHaveCount(0);
  await composer.fill("Keep the existing variants.");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "today-nested-steer");

  await page.getByRole("button", { name: "Choose message action" }).click();
  await expect(page.getByRole("menuitem", { name: "Steer", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Queue", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "today-nested-steer-menu");
  await page.keyboard.press("Escape");

  await page.keyboard.down("Alt");
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "today-nested-steer-morph");
  await page.keyboard.up("Alt");

  await page.keyboard.down("Meta");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "today-nested-queue-morph");
  await page.keyboard.up("Meta");
});

test("execution flow nested agent", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/today.html?scene=flow");
  await expect(page.getByTestId("execution-flow")).toBeVisible();
  await captureScreenshot(page, testInfo, "today-execution-flow");
});
