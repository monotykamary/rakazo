import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("quiet activity reveals retained Fabric, Fovea, compaction and queue controls", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/queue/list", (route) =>
    route.fulfill({
      json: {
        json: {
          version: 1,
          sessionId: "session",
          revision: 0,
          rows: [],
          identity: { nextIdNumber: 1, nextSequence: 1 },
          uncertainRowIds: [],
          paused: false,
          errorHold: false,
          modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
          gracefulPausePending: false,
        },
      },
    }),
  );
  const events = [
    {
      type: "agent.tool.called",
      payload: { toolName: "fabric_exec", code: "return await tools.catalog()" },
    },
    {
      type: "agent.tool.called",
      payload: { toolName: "fovea_focus", arguments: { query: "ReviewPatch" } },
    },
    {
      type: "runtime.activity",
      payload: { activity: "compaction", status: "completed", summary: "Retained review context" },
    },
  ].map((event, index) => ({
    ...event,
    id: `event-${index}`,
    seq: index + 1,
    runId: "run",
    botId: "bot",
    threadId: "thread",
    spaceId: "space",
    createdAt: "2026-09-01T12:00:00Z",
  }));
  await page.route("**/rpc/execution/inspect", (route) =>
    route.fulfill({
      json: {
        json: {
          runId: "run",
          events,
          nextCursor: 3,
          hasMore: false,
          participants: [{ botId: "bot", participantId: "worker", name: "Reviewer" }],
          flow: { nodes: [], edges: [], hasMoreRelatedRuns: false },
        },
      },
    }),
  );
  await page.goto("/e2e/fixtures/message-activity.html");
  await expect(page.getByRole("button", { name: /^Queue ·/ })).toHaveCount(0);
  await expect(page.getByText("Paused", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-contextual-activity");
  await page.getByRole("button", { name: "Execution", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Execution", exact: true });
  await expect(inspector).toBeVisible();
  const retainedEvents = inspector.getByRole("list", { name: "Retained events" });
  await retainedEvents.getByRole("button", { name: /Tool Fabric program/ }).click();
  await expect(
    inspector.getByText('"code": "return await tools.catalog()"', { exact: false }),
  ).toBeVisible();
  await retainedEvents.getByText("fovea_focus").click();
  await expect(inspector.getByText('"query": "ReviewPatch"', { exact: false })).toBeVisible();
  await retainedEvents.getByText("compaction").click();
  await expect(inspector.getByText("Retained review context", { exact: false })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Model", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "contextual-execution-details");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "contextual-execution-mobile-web");
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
  await page.locator("summary").filter({ hasText: "Advanced" }).click();
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Queue", exact: true })).toBeVisible();
  await expect(page.getByTestId("composer-queue")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Queued message", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "manual-empty-queue");
});
