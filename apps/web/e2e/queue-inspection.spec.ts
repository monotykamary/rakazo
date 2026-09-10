import { expect, test } from "@playwright/test";
import type { QueueMutation, QueueSnapshot } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

test("queue controls and retained execution inspection", async ({ page }, testInfo) => {
  let snapshot: QueueSnapshot = {
    version: 1,
    sessionId: "session",
    revision: 0,
    rows: [
      {
        id: "first",
        sequence: 1,
        lane: "followUp",
        text: "Review the patch",
        images: [],
        attachments: [
          { artifactId: "artifact-fixture", name: "notes.txt", mimeType: "text/plain", size: 12 },
        ],
        placement: {
          version: 1,
          kind: "unbound",
          computerId: null,
          homeKey: null,
          projectPath: null,
          worktreePath: null,
          revision: 0,
        },
      },
      {
        id: "second",
        sequence: 2,
        lane: "steer",
        text: "Keep the tests offline",
        images: [],
        paused: true,
      },
    ],
    identity: { nextIdNumber: 3, nextSequence: 3 },
    uncertainRowIds: [],
    paused: true,
    errorHold: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
    gracefulPausePending: false,
  };
  const operations: QueueMutation["operation"][] = [];
  let rejectTarget = true;
  await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
  await page.route("**/rpc/queue/mutate", async (route) => {
    const input = route.request().postDataJSON().json as QueueMutation;
    expect(input.threadId).toBe("thread");
    expect(input.botId).toBe("bot");
    expect(input.expectedRevision).toBe(snapshot.revision);
    const operation = input.operation;
    if (operation.type === "enqueue" && operation.target && rejectTarget) {
      rejectTarget = false;
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      await route.fulfill({
        json: {
          json: {
            version: 1,
            requestId: input.requestId,
            ok: false,
            error: "Revision conflict",
            snapshot,
          },
        },
      });
      return;
    }
    operations.push(operation);
    snapshot = structuredClone(snapshot);
    snapshot.revision++;
    if (operation.type === "edit-begin")
      snapshot.editing = {
        selectedId: operation.id,
        rows: snapshot.rows.map((row) => ({ ...row, removed: false })),
      };
    if (operation.type === "edit-patch" && snapshot.editing)
      Object.assign(
        snapshot.editing.rows.find((row) => row.id === snapshot.editing?.selectedId)!,
        operation.patch,
      );
    if (operation.type === "edit-save") {
      snapshot.rows = snapshot.editing!.rows;
      delete snapshot.editing;
    }
    if (operation.type === "edit-cancel") delete snapshot.editing;
    if (operation.type === "hold")
      snapshot.rows.find((row) => row.id === operation.id)!.paused = operation.paused;
    if (operation.type === "lane")
      snapshot.rows.find((row) => row.id === operation.id)!.lane = operation.lane;
    if (operation.type === "remove")
      snapshot.rows = snapshot.rows.filter((row) => row.id !== operation.id);
    if (operation.type === "reorder") snapshot.rows.reverse();
    if (operation.type === "resume") snapshot.paused = false;
    if (operation.type === "pause") snapshot.paused = true;
    if (operation.type === "graceful-pause") snapshot.gracefulPausePending = true;
    if (operation.type === "enqueue")
      snapshot.rows.push({
        id: "third",
        sequence: 3,
        lane: operation.lane,
        text: operation.text,
        images: operation.images ?? [],
        target: operation.target,
      });
    await route.fulfill({
      json: { json: { version: 1, requestId: input.requestId, ok: true, snapshot } },
    });
  });
  await page.route("**/rpc/execution/inspect", (route) =>
    route.fulfill({
      json: {
        json: {
          runId: route.request().postDataJSON().json.runId,
          events: [
            {
              id: route.request().postDataJSON().json.runId === "run" ? "event" : "related-event",
              spaceId: "space",
              threadId: "thread",
              botId: "bot",
              runId: route.request().postDataJSON().json.runId,
              seq: 4,
              type: "agent.tool.called",
              createdAt: "2026-07-19T12:00:00Z",
              payload: {
                toolName: "bash",
                arguments: { command: "npm test" },
                code: "await tools.bash({ command: 'npm test' })",
              },
            },
          ],
          nextCursor: 4,
          hasMore: false,
          participants: [
            { botId: "bot" },
            { botId: "other-bot", participantId: "foreign", name: "Foreign" },
            { botId: "bot", participantId: "worker", name: "Worker" },
          ],
          flow: {
            nodes: [
              {
                id: "run:run",
                kind: "run",
                name: "Main",
                botId: "bot",
                runId: "run",
                evidence: [{ kind: "run", id: "run" }],
              },
              {
                id: "run:related-run",
                kind: "run",
                name: "Main",
                botId: "bot",
                runId: "related-run",
                code: "return 2;",
                evidence: [{ kind: "run", id: "related-run" }],
              },
              {
                id: "bot:bot",
                kind: "participant",
                name: "Main",
                botId: "bot",
                evidence: [{ kind: "message", id: "receipt" }],
              },
              {
                id: "participant:worker",
                kind: "participant",
                name: "Worker",
                participantId: "worker",
                evidence: [{ kind: "event", id: "event" }],
              },
              {
                id: "message:1",
                kind: "message",
                name: "Review request",
                evidence: [{ kind: "message", id: "message-1" }],
              },
              {
                id: "wait:1",
                kind: "wait",
                name: "Approval",
                evidence: [{ kind: "event", id: "event" }],
              },
              {
                id: "execution:1",
                kind: "execution",
                name: "Tool call",
                code: "await tools.bash({ command: 'npm test' })",
                evidence: [{ kind: "event", id: "event" }],
              },
            ],
            edges: [
              {
                id: "continuation",
                from: "run:run",
                to: "run:related-run",
                kind: "continues",
                evidence: [{ kind: "run", id: "related-run" }],
              },
              {
                id: "delegate",
                from: "run:run",
                to: "participant:worker",
                kind: "delegates",
                evidence: [{ kind: "event", id: "event" }],
              },
              {
                id: "message",
                from: "participant:worker",
                to: "message:1",
                kind: "messages",
                evidence: [{ kind: "message", id: "message-1" }],
              },
              {
                id: "wait",
                from: "run:run",
                to: "wait:1",
                kind: "waits-for",
                evidence: [{ kind: "event", id: "event" }],
              },
              {
                id: "continue",
                from: "run:run",
                to: "execution:1",
                kind: "continues",
                evidence: [{ kind: "event", id: "event" }],
              },
            ],
            hasMoreRelatedRuns: false,
          },
        },
      },
    }),
  );
  const effective = { provider: "local", modelId: "small", thinkingLevel: null };
  let requestedModel: unknown;
  await page.route("**/rpc/models/runtime", (route) =>
    route.fulfill({
      json: {
        json: {
          catalog: [
            {
              provider: "local",
              id: "small",
              label: "Small",
              billing: "local",
              thinkingLevels: ["low", "high"],
            },
            {
              provider: "local",
              id: "large",
              label: "Large",
              billing: "local",
              thinkingLevels: ["low", "high"],
            },
          ],
          current: effective,
          profileDefault: effective,
          selection: {
            requested: requestedModel ?? effective,
            effective,
            status: requestedModel === undefined ? "applied" : "pending",
            error: null,
          },
          availability: { status: "available", error: null },
        },
      },
    }),
  );
  await page.route("**/rpc/models/setWorkerSelection", (route) => {
    const input = route.request().postDataJSON().json;
    expect(input).toMatchObject({ botId: "bot", threadId: "thread", participantId: "worker" });
    requestedModel = input.selection;
    return route.fulfill({
      json: {
        json: {
          requested: input.selection ?? effective,
          effective,
          status: "pending",
          error: null,
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/queue-inspection.html");
  const queueRegion = page.getByRole("region", { name: "Queue", exact: true });
  await expect(page.getByRole("button", { name: "Queue, 2 messages" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Queued message", exact: true })).toHaveCount(0);
  await expect(queueRegion.getByRole("button", { name: "Execution" })).toHaveCount(0);
  await expect(page.locator('[data-row-id="second"]')).toHaveAttribute("data-lane", "steer");
  const first = page.locator('[data-row-id="first"]');
  await expect(first).toContainText("notes.txt");
  expect(snapshot.rows[0]?.attachments?.[0]?.artifactId).toBe("artifact-fixture");

  await first.getByLabel(/Options for queued message:/).click();
  await page.getByRole("menuitem", { name: "Use current project", exact: true }).click();
  await first.getByLabel(/Options for queued message:/).click();
  await page.getByRole("menuitem", { name: "Move to steer", exact: true }).click();
  await first.getByLabel(/Options for queued message:/).click();
  await page.getByRole("menuitem", { name: "Hold", exact: true }).click();
  await expect(first.getByLabel("Held")).toBeVisible();
  await first.getByLabel(/Options for queued message:/).click();
  await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect(page.locator("[data-row-id]").first()).toHaveAttribute("data-row-id", "second");

  await page.getByLabel("Queue options", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Resume", exact: true }).click();
  await page.getByLabel("Queue options", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Pause", exact: true }).click();
  await page.getByLabel("Queue options", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Pause after tools", exact: true }).click();
  await captureScreenshot(page, testInfo, "queue-controls");
  await page.getByRole("button", { name: "Execution", exact: true }).click();
  const execution = page.getByRole("dialog", { name: "Execution", exact: true });
  const runs = execution.getByRole("navigation", { name: "Run", exact: true });
  await expect(runs.getByRole("button", { name: "Run 1", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(execution.getByRole("combobox", { name: "Run", exact: true })).toHaveCount(0);
  await expect(execution.getByRole("button", { name: "Flow", exact: true })).toHaveCount(0);
  await expect(execution.getByRole("button", { name: "Model", exact: true })).toHaveCount(1);
  await execution.getByRole("button", { name: "Model", exact: true }).click();
  await execution.getByRole("option", { name: "Large local/large", exact: true }).click();
  await execution.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("high");
  await expect(execution.getByTestId("current-model")).toHaveText("Current: local/small");
  await expect(
    execution.getByText(`Pending · local/${requestedModel ? "large" : "small"}`, { exact: true }),
  ).toBeVisible();
  expect(requestedModel).toEqual({ provider: "local", modelId: "large", thinkingLevel: "high" });
  await captureScreenshot(page, testInfo, "execution-worker-model");
  await execution.getByRole("button", { name: "Model", exact: true }).click();
  await execution.getByRole("list", { name: "Retained events" }).getByText("bash").click();
  await expect(page.getByText("npm test", { exact: false })).toBeVisible();
  await expect(page.getByText("run.completed", { exact: false })).toHaveCount(0);
  await expect(execution.getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-flow-node]")).toHaveCount(5);
  const outline = execution.getByTestId("execution-flow");
  await expect(outline.getByRole("region", { name: "Evidence", exact: true })).toHaveCount(0);
  await expect(outline).not.toContainText("run:run");
  await expect(outline.getByText("Main", { exact: true })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "execution-evidence");
  await captureScreenshot(page, testInfo, "execution-flow");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      outline.evaluate((element) =>
        Array.from(element.querySelectorAll("*")).every(
          (item) => item.scrollWidth <= item.clientWidth + 1,
        ),
      ),
    )
    .toBe(true);
  await captureScreenshot(page, testInfo, "execution-flow-narrow");
  await page.emulateMedia({ colorScheme: "dark" });
  await captureScreenshot(page, testInfo, "execution-flow-narrow-dark");
  await runs.getByRole("button", { name: "Run 2", exact: true }).click();
  await expect(runs.getByRole("button", { name: "Run 2", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(operations.map((operation) => operation.type)).toEqual([
    "bind-placement",
    "lane",
    "hold",
    "reorder",
    "resume",
    "pause",
    "graceful-pause",
  ]);
});
