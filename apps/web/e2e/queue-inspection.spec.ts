import { expect, test } from "@playwright/test";
import type { QueueMutation, QueueSnapshot } from "@rakazo/contracts";
import { expectAlignedControls } from "../../../packages/testkit/src/playwright-layout";
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
          {
            provider: "local",
            id: "large",
            label: "Large",
            billing: "local",
            thinkingLevels: ["low", "high"],
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/getVisibility", (route) =>
    route.fulfill({ json: { json: { hide: [] } } }),
  );
  const effective = { provider: "local", modelId: "small", thinkingLevel: null };
  await page.route("**/rpc/models/getSelection", (route) =>
    route.fulfill({
      json: { json: { requested: effective, effective, status: "applied", error: null } },
    }),
  );
  let requestedModel: unknown;
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
  await expect(page.getByRole("button", { name: "Queue · 2", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Queued message", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Queue · 2", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use current project" })).toBeEnabled();
  const first = page.locator('[data-row-id="first"]');
  await first.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit queued message" }).fill("Review the actual patch");
  await first.getByLabel("Add attachments").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(first.getByAltText("Attachment 1")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(first).toContainText("Review the actual patch");
  await expect(first.getByAltText("Attachment 1")).toBeVisible();
  await expect(first.getByRole("textbox", { name: "Edit queued message" })).toHaveCount(0);
  expect(snapshot.rows[0]?.images[0]?.mimeType).toBe("image/png");
  await first.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(first.getByRole("button", { name: "Follow-up", exact: true })).toBeVisible();
  await first.getByRole("button", { name: "Hold", exact: true }).click();
  await expect(first).toContainText("Held");
  await first.getByRole("button", { name: "Move down", exact: true }).click();
  await expect(page.locator("[data-row-id]").first()).toHaveAttribute("data-row-id", "second");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Pause after tools", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause pending" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Queued message", exact: true }).fill("Next run");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  await expect(page.locator('[data-row-id="third"]')).toContainText("Next run");
  await page
    .locator('[data-row-id="third"]')
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(page.locator('[data-row-id="third"]')).toHaveCount(0);
  await captureScreenshot(page, testInfo, "queue-controls");
  await page.getByRole("button", { name: "Execution", exact: true }).click();
  const execution = page.getByRole("dialog", { name: "Execution", exact: true });
  const runSelect = execution.getByRole("combobox", { name: "Run", exact: true });
  const flowButton = execution.getByRole("button", { name: "Flow", exact: true });
  await expectAlignedControls(runSelect, flowButton);
  await expect(execution.getByRole("button", { name: "Model", exact: true })).toHaveCount(1);
  await execution.getByRole("button", { name: "Model", exact: true }).click();
  await execution
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("local::large");
  await execution.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("high");
  await execution.getByRole("button", { name: "Save", exact: true }).click();
  await expect(execution.getByText("Pending · Effective: small")).toBeVisible();
  expect(requestedModel).toEqual({ provider: "local", modelId: "large", thinkingLevel: "high" });
  await captureScreenshot(page, testInfo, "execution-worker-model");
  await execution.getByRole("button", { name: "Use bot model", exact: true }).click();
  await expect.poll(() => requestedModel).toBeNull();
  await expect(execution.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "local::small",
  );
  await expect(execution.getByText("Pending · Effective: small")).toBeVisible();
  await execution.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByText("agent.tool.called", { exact: false }).click();
  await expect(page.getByText("npm test", { exact: false })).toBeVisible();
  await expect(page.getByText("run.completed", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message to participant" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Steer participant", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Steer participant", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message to participant" })
    .fill("Focus on the failing test");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Queue message", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Revision conflict");
  await expect(page.getByRole("textbox", { name: "Message to participant" })).toHaveValue(
    "Focus on the failing test",
  );
  expect(operations.at(-1)?.type).toBe("remove");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Queue message", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Message to participant" })).toHaveCount(0);
  expect(operations.at(-1)).toEqual({
    type: "enqueue",
    lane: "steer",
    text: "Focus on the failing test",
    target: { participantId: "worker" },
  });
  await expect(page.locator("[data-flow-node]")).toHaveCount(5);
  const outline = execution.getByTestId("execution-flow");
  await expect(outline.getByRole("region", { name: "Evidence", exact: true })).toHaveCount(0);
  await expect(outline).not.toContainText("run:run");
  await expect(outline.getByText("Main", { exact: true })).toHaveCount(1);
  await outline.locator('[data-flow-node="bot:bot"]').click();
  await outline.locator('[data-flow-edge="delegate"]').click();
  const evidencePanel = page.getByRole("region", { name: "Evidence", exact: true });
  await evidencePanel.locator("summary").click();
  await expect(evidencePanel.getByText("event", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show events", exact: true }).click();
  await expect(flowButton).toBeFocused();
  await page.getByText("agent.tool.called", { exact: false }).click();
  await expect(page.getByText("npm test", { exact: false })).toBeVisible();
  await captureScreenshot(page, testInfo, "execution-evidence");
  await flowButton.click();
  await expect(outline).toBeVisible();
  await expect(execution.getByRole("list", { name: "Retained events" })).toHaveCount(0);
  await page.getByRole("dialog").evaluate((element) => {
    element.scrollTop = 0;
  });
  await captureScreenshot(page, testInfo, "execution-flow");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectAlignedControls(runSelect, flowButton);
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
  await expectAlignedControls(runSelect, flowButton);
  await captureScreenshot(page, testInfo, "execution-flow-narrow-dark");
  await outline.locator('[data-flow-node="bot:bot"]').click();
  await expect(outline.getByRole("button", { name: "Run 1", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await outline.getByRole("button", { name: "Run 2", exact: true }).click();
  await expect(runSelect).toHaveValue("related-run");
  await expect(flowButton).toBeFocused();
  await expect(outline).toHaveCount(0);
  await flowButton.click();
  await outline.locator('[data-flow-node="bot:bot"]').click();
  await expect(outline.getByRole("button", { name: "Run 2", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(outline.getByText("return 2;", { exact: true })).toBeVisible();
  expect(operations.map((operation) => operation.type)).toEqual([
    "edit-begin",
    "edit-patch",
    "edit-save",
    "lane",
    "hold",
    "reorder",
    "resume",
    "pause",
    "graceful-pause",
    "enqueue",
    "remove",
    "enqueue",
  ]);
});
