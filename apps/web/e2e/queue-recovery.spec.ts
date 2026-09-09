import { expect, type Page, test } from "@playwright/test";
import type { QueueMutation, QueueSnapshot } from "@rakazo/contracts";

function baseSnapshot(rows: QueueSnapshot["rows"]): QueueSnapshot {
  return {
    version: 1,
    sessionId: "session",
    revision: 0,
    rows,
    identity: { nextIdNumber: rows.length + 1, nextSequence: rows.length + 1 },
    uncertainRowIds: [],
    paused: true,
    errorHold: false,
    gracefulPausePending: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
  };
}

function row(id: string, text: string): QueueSnapshot["rows"][number] {
  return { id, sequence: Number(id.replace(/\D/g, "")) || 1, lane: "followUp", text, images: [] };
}

async function mount(page: Page, initial: QueueSnapshot) {
  let snapshot = initial;
  const operations: QueueMutation["operation"][] = [];
  let rejectResume = false;
  await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
  await page.route("**/rpc/queue/mutate", async (route) => {
    const input = route.request().postDataJSON().json as QueueMutation;
    const operation = input.operation;
    if (operation.type === "resume" && rejectResume) {
      rejectResume = false;
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
    snapshot.revision += 1;
    if (operation.type === "bind-placement") {
      const target = snapshot.rows.find((candidate) => candidate.id === operation.id)!;
      target.placement = {
        version: 1,
        kind: "project",
        computerId: "computer",
        homeKey: "home",
        projectPath: "/projects/fixture",
        worktreePath: null,
        revision: 1,
      };
    }
    if (operation.type === "resume") {
      snapshot.paused = false;
      snapshot.errorHold = false;
      snapshot.uncertainRowIds = [];
    }
    if (operation.type === "pause") snapshot.paused = true;
    if (operation.type === "drain")
      snapshot.drain = { requestId: input.requestId, rowIds: snapshot.rows.map((item) => item.id) };
    if (operation.type === "edit-begin") {
      snapshot.editing = {
        selectedId: operation.id,
        rows: snapshot.rows.map((item) => ({ ...item, removed: false })),
      };
    }
    await route.fulfill({
      json: { json: { version: 1, requestId: input.requestId, ok: true, snapshot } },
    });
  });
  await page.goto("/e2e/fixtures/queue-inspection.html");
  return {
    operations,
    snapshot: () => snapshot,
    rejectNextResume: () => {
      rejectResume = true;
    },
  };
}

test("unbound placement recovery stays scoped to the selected row", async ({ page }) => {
  const unbound = {
    version: 1 as const,
    kind: "unbound" as const,
    computerId: null,
    homeKey: null,
    projectPath: null,
    worktreePath: null,
    revision: 0,
  };
  const bound = {
    ...unbound,
    kind: "project" as const,
    computerId: "existing-computer",
    homeKey: "existing-home",
    projectPath: "/projects/existing",
    revision: 3,
  };
  const initial = baseSnapshot([
    { ...row("row-1", "Recover me"), placement: unbound },
    { ...row("row-2", "Keep my project"), placement: bound },
  ]);
  const queue = await mount(page, initial);
  await page
    .locator('[data-row-id="row-1"]')
    .getByLabel(/Options for queued message:/)
    .click();
  await page.getByRole("menuitem", { name: "Use current project" }).click();
  await expect(page.locator('[data-row-id="row-1"]').getByLabel("Project bound")).toBeVisible();
  expect(queue.snapshot().rows[1]?.placement).toEqual(bound);
  expect(queue.operations).toEqual([{ type: "bind-placement", id: "row-1" }]);
});

test("uncertain resume requires consent and remains retryable after a conflict", async ({
  page,
}) => {
  const initial = baseSnapshot([row("row-1", "Possibly delivered")]);
  initial.errorHold = true;
  initial.uncertainRowIds = ["row-1"];
  const queue = await mount(page, initial);
  queue.rejectNextResume();
  await page.getByLabel("Queue options").click();
  await page.getByRole("menuitem", { name: "Resume" }).click();
  const dialog = page.getByRole("dialog", { name: "Resume uncertain deliveries?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("alert")).toContainText("Revision conflict");
  await dialog.getByRole("button", { name: "Resume" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Delivery uncertain")).toHaveCount(0);
  expect(queue.operations).toEqual([{ type: "resume" }]);
});

test("drain is progressive and becomes locked after one accepted request", async ({ page }) => {
  const initial = baseSnapshot([
    {
      ...row("row-1", "Drain me"),
      placement: {
        version: 1,
        kind: "none",
        computerId: null,
        homeKey: null,
        projectPath: null,
        worktreePath: null,
        revision: 0,
      },
    },
  ]);
  initial.paused = false;
  const queue = await mount(page, initial);
  await expect(page.getByRole("button", { name: "Drain all" })).toHaveCount(0);
  await page.getByLabel("Queue options").click();
  await page.getByRole("menuitem", { name: "Drain all" }).click();
  await page.getByLabel("Queue options").click();
  await expect(page.getByRole("menuitem", { name: "Drain all" })).toBeDisabled();
  expect(queue.operations).toEqual([{ type: "drain" }]);
});

for (const locked of ["inFlight", "compaction", "gracefulPausePending", "errorHold"] as const) {
  test(`drain is disabled during ${locked}`, async ({ page }) => {
    const initial = baseSnapshot([
      {
        ...row("row-1", "Blocked"),
        placement: {
          version: 1,
          kind: "none",
          computerId: null,
          homeKey: null,
          projectPath: null,
          worktreePath: null,
          revision: 0,
        },
      },
    ]);
    initial.paused = false;
    if (locked === "inFlight") initial.inFlight = { attemptId: "attempt", rowIds: ["row-1"] };
    if (locked === "compaction") initial.compaction = "manual";
    if (locked === "gracefulPausePending") initial.gracefulPausePending = true;
    if (locked === "errorHold") initial.errorHold = true;
    await mount(page, initial);
    await page.getByLabel("Queue options").click();
    await expect(page.getByRole("menuitem", { name: "Drain all" })).toBeDisabled();
  });
}

test("empty queue renders no queue chrome or add textarea", async ({ page }) => {
  await mount(page, baseSnapshot([]));
  await expect(page.getByRole("region", { name: "Queue", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Queued message" })).toHaveCount(0);
  await expect(page.getByText("Add queued message", { exact: true })).toHaveCount(0);
});
