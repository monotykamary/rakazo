import { expect, test } from "@playwright/test";
import type { QueueMutation, QueueSnapshot } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

test("unbound placement recovers through the server without changing established bindings", async ({
  page,
}, testInfo) => {
  const unbound = {
    version: 1 as const,
    kind: "unbound" as const,
    computerId: null,
    homeKey: null,
    projectPath: null,
    worktreePath: null,
    revision: 0,
  };
  const project = {
    ...unbound,
    kind: "project" as const,
    computerId: "computer",
    homeKey: "home",
    projectPath: "/projects/example",
    revision: 1,
  };
  let snapshot: QueueSnapshot = {
    version: 1,
    sessionId: "session",
    revision: 0,
    rows: [
      {
        id: "unbound",
        sequence: 1,
        lane: "followUp",
        text: "Recover me",
        images: [],
        placement: unbound,
      },
      {
        id: "bound",
        sequence: 2,
        lane: "followUp",
        text: "Keep my project",
        images: [],
        placement: project,
      },
      {
        id: "none",
        sequence: 3,
        lane: "followUp",
        text: "No project needed",
        images: [],
        placement: { ...unbound, kind: "none" },
      },
      { id: "legacy", sequence: 4, lane: "followUp", text: "Legacy message", images: [] },
    ],
    identity: { nextIdNumber: 5, nextSequence: 5 },
    uncertainRowIds: [],
    paused: true,
    errorHold: false,
    gracefulPausePending: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
  };
  const requests: QueueMutation[] = [];
  let release: (() => void) | undefined;
  await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
  await page.route("**/rpc/queue/mutate", async (route) => {
    const input = route.request().postDataJSON().json as QueueMutation;
    requests.push(input);
    expect(input.operation).toEqual({ type: "bind-placement", id: "unbound" });
    expect(input.expectedRevision).toBe(snapshot.revision);
    const ok = requests.length > 1;
    if (!ok)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (ok)
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        rows: snapshot.rows.map((row) =>
          row.id === "unbound" ? { ...row, placement: project } : row,
        ),
      };
    await route.fulfill({
      json: {
        json: {
          version: 1,
          requestId: input.requestId,
          ok,
          snapshot,
          ...(ok ? {} : { error: "Current project unavailable" }),
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/queue-inspection.html");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const recover = page.getByRole("button", { name: "Use current project", exact: true });
  await expect(recover).toHaveCount(1);
  await expect(recover).toBeEnabled();
  await captureScreenshot(page, testInfo, "queue-project-recovery");
  await recover.click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(recover).toBeDisabled();
  release!();
  await expect(page.getByRole("alert")).toHaveText("Current project unavailable");
  await expect(recover).toBeEnabled();
  expect(snapshot.rows[0]?.placement).toEqual(unbound);
  await recover.click();
  await expect(recover).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(snapshot.rows[0]?.placement).toEqual(project);
  expect(snapshot.rows[1]?.placement).toEqual(project);
});

for (const blocked of ["editing", "inFlight"] as const) {
  test(`project recovery is disabled during ${blocked}`, async ({ page }) => {
    const row: QueueSnapshot["rows"][number] = {
      id: "unbound",
      sequence: 1,
      lane: "followUp",
      text: "Recover me",
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
    };
    const snapshot: QueueSnapshot = {
      version: 1,
      sessionId: "session",
      revision: 0,
      rows: [row],
      identity: { nextIdNumber: 2, nextSequence: 2 },
      uncertainRowIds: [],
      paused: true,
      errorHold: false,
      gracefulPausePending: false,
      modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
      ...(blocked === "editing"
        ? { editing: { selectedId: row.id, rows: [{ ...row, removed: false }] } }
        : { inFlight: { attemptId: "attempt", rowIds: [row.id] } }),
    };
    await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
    await page.goto("/e2e/fixtures/queue-inspection.html");
    await expect(page.getByRole("button", { name: "Queue", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByRole("button", { name: "Use current project" })).toBeDisabled();
  });
}

test("uncertain delivery requires consent and revision conflicts stay recoverable", async ({
  page,
}, testInfo) => {
  let snapshot: QueueSnapshot = {
    version: 1,
    sessionId: "session",
    revision: 2,
    rows: [
      { id: "uncertain", sequence: 1, lane: "followUp", text: "Retained instruction", images: [] },
    ],
    identity: { nextIdNumber: 2, nextSequence: 2 },
    uncertainRowIds: ["uncertain"],
    paused: true,
    errorHold: true,
    gracefulPausePending: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
  };
  const requests: QueueMutation[] = [];
  await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
  await page.route("**/rpc/queue/mutate", async (route) => {
    const input = route.request().postDataJSON().json as QueueMutation;
    requests.push(input);
    const ok = requests.length > 1;
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      ...(ok ? { uncertainRowIds: [], paused: false, errorHold: false } : {}),
    };
    await route.fulfill({
      json: {
        json: {
          version: 1,
          requestId: input.requestId,
          ok,
          ...(ok ? {} : { error: "Revision conflict" }),
          snapshot,
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/queue-inspection.html");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByText("Waiting for recovery", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Resuming can send it again");
  expect(requests).toHaveLength(0);
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Revision conflict");
  expect(requests).toHaveLength(1);
  await captureScreenshot(page, testInfo, "queue-recovery-conflict");
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.expectedRevision).toBe(3);
  await expect(page.getByText("Delivery uncertain", { exact: true })).toHaveCount(0);
});

test("inline timeline keeps drafts and sends one server-owned drain", async ({
  page,
}, testInfo) => {
  let snapshot: QueueSnapshot = {
    version: 1,
    sessionId: "session",
    revision: 0,
    rows: [
      {
        id: "root",
        sequence: 1,
        lane: "followUp",
        text: "Start review",
        images: [],
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
      {
        id: "child",
        sequence: 2,
        lane: "steer",
        text: "Check tests",
        images: [],
        target: { participantId: "private-target-id" },
      },
    ],
    identity: { nextIdNumber: 3, nextSequence: 3 },
    uncertainRowIds: [],
    paused: true,
    errorHold: false,
    gracefulPausePending: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
  };
  const operations: QueueMutation["operation"][] = [];
  await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
  await page.route("**/rpc/queue/mutate", async (route) => {
    const input = route.request().postDataJSON().json as QueueMutation;
    expect(input.expectedRevision).toBe(snapshot.revision);
    operations.push(input.operation);
    snapshot = structuredClone(snapshot);
    snapshot.revision++;
    const operation = input.operation;
    if (operation.type === "edit-begin")
      snapshot.editing = {
        selectedId: operation.id,
        rows: snapshot.rows.map((row) => ({ ...row, removed: false })),
      };
    if (operation.type === "edit-patch") Object.assign(snapshot.editing!.rows[0]!, operation.patch);
    if (operation.type === "edit-cancel") delete snapshot.editing;
    const ok =
      operation.type !== "drain" || operations.filter((item) => item.type === "drain").length > 1;
    if (operation.type === "drain" && ok)
      snapshot.drain = { requestId: input.requestId, rowIds: ["root"] };
    await route.fulfill({
      json: {
        json: {
          version: 1,
          requestId: input.requestId,
          ok,
          snapshot,
          ...(ok ? {} : { error: "Dispatch unavailable" }),
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/queue-inspection.html");
  const queue = page.getByRole("region", { name: "Queue", exact: true });
  await expect(queue.getByRole("list", { name: "Execution order" })).toBeVisible();
  await expect(queue).not.toContainText("private-target-id");
  await expect(queue).toContainText("Participant targeted");
  await expect(queue.getByRole("button", { name: "Execution" })).toHaveCount(0);
  const root = queue.locator('[data-row-id="root"]');
  await expect(page.getByRole("menuitem", { name: "Hold", exact: true })).toBeHidden();
  await root.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(queue.getByRole("button", { name: "Drain all" })).toBeDisabled();
  await root.getByRole("textbox").fill("Unsaved draft");
  await root.getByLabel("Message options", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Steer", exact: true }).click();
  await page.getByRole("menu").press("Escape");
  await expect(root).toHaveClass(/ms-5/);
  await expect(root.getByRole("textbox")).toHaveValue("Unsaved draft");
  await root.getByRole("textbox").press("Escape");
  await expect(root).not.toHaveClass(/ms-5/);
  await expect(root).toContainText("Start review");
  await queue.getByRole("button", { name: "Drain all" }).click();
  await expect(queue.getByRole("alert")).toHaveText("Dispatch unavailable");
  expect(operations.filter((operation) => operation.type === "drain")).toEqual([{ type: "drain" }]);
  await expect(queue.locator("[data-row-id]")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() => queue.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await captureScreenshot(page, testInfo, "queue-inline-timeline");
  await queue.getByRole("button", { name: "Drain all" }).click();
  await expect(queue.getByRole("button", { name: "Drain all" })).toBeDisabled();
  await expect(queue.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await expect(queue.locator("[data-row-id]")).toHaveCount(2);
  await expect(queue.getByRole("alert")).toHaveCount(0);
});

for (const state of [
  "inFlight",
  "drain",
  "compaction",
  "gracefulPausePending",
  "errorHold",
  "uncertain",
  "held",
  "unbound",
  "legacy",
] as const) {
  test(`drain eligibility respects ${state}`, async ({ page }) => {
    const snapshot: QueueSnapshot = {
      version: 1,
      sessionId: "session",
      revision: 0,
      rows: [
        {
          id: "first",
          sequence: 1,
          lane: "followUp",
          text: "Review",
          images: [],
          paused: state === "held",
          ...(state === "legacy"
            ? {}
            : {
                placement: {
                  version: 1,
                  kind: state === "unbound" ? "unbound" : "none",
                  computerId: null,
                  homeKey: null,
                  projectPath: null,
                  worktreePath: null,
                  revision: 0,
                },
              }),
        },
      ],
      identity: { nextIdNumber: 2, nextSequence: 2 },
      uncertainRowIds: state === "uncertain" ? ["first"] : [],
      paused: true,
      errorHold: state === "errorHold",
      gracefulPausePending: state === "gracefulPausePending",
      modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
      ...(state === "inFlight" ? { inFlight: { attemptId: "attempt", rowIds: ["first"] } } : {}),
      ...(state === "drain" ? { drain: { requestId: "request", rowIds: ["first"] } } : {}),
      ...(state === "compaction" ? { compaction: "manual" as const } : {}),
    };
    const operations: QueueMutation["operation"][] = [];
    await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
    await page.route("**/rpc/queue/mutate", (route) => {
      const input = route.request().postDataJSON().json as QueueMutation;
      operations.push(input.operation);
      return route.fulfill({
        json: { json: { version: 1, requestId: input.requestId, ok: true, snapshot } },
      });
    });
    await page.goto("/e2e/fixtures/queue-inspection.html?controlled");
    const queue = page.getByRole("region", { name: "Queue", exact: true });
    const toggle = queue.getByRole("button", { name: "Queue", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(queue.getByRole("button", { name: "Drain all" })).toBeDisabled();
    await queue.getByLabel("Message options", { exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "Move down" })).toBeDisabled();
    if (state === "inFlight" || state === "drain") {
      for (const name of ["Hold", "Steer", "Remove"])
        await expect(page.getByRole("menuitem", { name, exact: true })).toBeDisabled();
    }
    await page.getByRole("menu").press("Escape");
    if (state === "inFlight" || state === "drain")
      await expect(queue.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
    if (["inFlight", "compaction", "gracefulPausePending"].includes(state))
      await expect(queue.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
    if (state === "drain") {
      await queue.getByRole("button", { name: "Pause", exact: true }).click();
      await expect.poll(() => operations).toEqual([{ type: "pause" }]);
    }
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
}

test("empty queue is a compact disclosure", async ({ page }) => {
  const snapshot: QueueSnapshot = {
    version: 1,
    sessionId: "session",
    revision: 0,
    rows: [],
    identity: { nextIdNumber: 1, nextSequence: 1 },
    uncertainRowIds: [],
    paused: true,
    errorHold: false,
    gracefulPausePending: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
  };
  await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
  await page.goto("/e2e/fixtures/queue-inspection.html");
  const queue = page.getByRole("region", { name: "Queue", exact: true });
  await expect(queue.getByRole("button")).toHaveCount(1);
  await queue.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(queue.getByRole("button", { name: "Drain all" })).toBeDisabled();
  await expect(queue.getByRole("textbox")).toHaveCount(0);
});
