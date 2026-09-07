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
  await page.getByRole("button", { name: "Queue · 4", exact: true }).click();
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
    await page.getByRole("button", { name: "Queue · 1", exact: true }).click();
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
  await page.getByRole("button", { name: "Queue · 1", exact: true }).click();
  await expect(page.getByText("Recovery hold", { exact: true })).toBeVisible();
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
