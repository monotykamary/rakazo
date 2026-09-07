import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("quiet activity reveals retained Fabric, Fovea, compaction and worker controls", async ({
  page,
}, testInfo) => {
  const effective = { provider: "local", modelId: "small", thinkingLevel: null };
  await page.route("**/rpc/models/getVisibility", (route) =>
    route.fulfill({ json: { json: { hide: [] } } }),
  );
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
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [{ id: "local", provider: "local", label: "Local", hasKey: false, isDefault: true }],
      },
    }),
  );
  await page.route("**/rpc/models/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            provider: "local",
            id: "small",
            label: "Small",
            billing: "local",
            thinkingLevels: ["low", "high"],
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/getSelection", (route) =>
    route.fulfill({
      json: { json: { requested: effective, effective, status: "applied", error: null } },
    }),
  );
  const selections: unknown[] = [];
  await page.route("**/rpc/models/setWorkerSelection", (route) => {
    const input = route.request().postDataJSON().json;
    selections.push(input);
    return route.fulfill({
      json: { json: { requested: input.selection, effective, status: "pending", error: null } },
    });
  });
  await page.goto("/e2e/fixtures/message-activity.html");
  await expect(page.getByRole("button", { name: /^Queue ·/ })).toHaveCount(0);
  await expect(page.getByText("Paused", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-contextual-activity");
  await page.getByRole("button", { name: "Execution", exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Execution", exact: true });
  await expect(inspector).toBeVisible();
  await inspector.locator("summary").filter({ hasText: "fabric_exec" }).click();
  await expect(
    inspector.getByText('"code": "return await tools.catalog()"', { exact: false }),
  ).toBeVisible();
  await inspector.locator("summary").filter({ hasText: "fovea_focus" }).click();
  await expect(inspector.getByText('"query": "ReviewPatch"', { exact: false })).toBeVisible();
  await inspector.locator("summary").filter({ hasText: "compaction" }).click();
  await expect(inspector.getByText("Retained review context", { exact: false })).toBeVisible();
  await inspector.getByRole("button", { name: "Model", exact: true }).click();
  await expect(inspector.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "local::small",
  );
  await inspector.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("high");
  await inspector.getByRole("button", { name: "Save", exact: true }).click();
  await expect(inspector.getByText("Pending · Effective: small", { exact: true })).toBeVisible();
  expect(selections).toEqual([
    {
      botId: "bot",
      threadId: "thread",
      participantId: "worker",
      selection: { provider: "local", modelId: "small", thinkingLevel: "high" },
    },
  ]);
  await inspector.getByRole("button", { name: "Use bot model", exact: true }).click();
  await expect(inspector.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("");
  expect(selections[1]).toEqual({
    botId: "bot",
    threadId: "thread",
    participantId: "worker",
    selection: null,
  });
  await captureScreenshot(page, testInfo, "contextual-execution-details");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "contextual-execution-mobile-web");
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
  await page.locator("summary").filter({ hasText: "Advanced" }).click();
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Queue", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Queued message", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "manual-empty-queue");
});
