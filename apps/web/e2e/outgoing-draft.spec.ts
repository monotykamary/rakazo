import { expect, type Page, test } from "@playwright/test";
import { type OutgoingMessageDraft, OutgoingMessageDraftSchema } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

function draftHash(revision: number) {
  return revision.toString(16).padStart(64, "0");
}

function initialDraft(): OutgoingMessageDraft {
  return {
    kind: "outgoing_message",
    revision: 1,
    hash: draftHash(1),
    status: "pending",
    channel: "email",
    canApprove: true,
    ownerUserId: "owner-fixture",
    fields: {
      to: ["alex@example.test", "sam@example.test"],
      cc: ["review@example.test"],
      bcc: ["archive@example.test"],
      subject: "Friday review",
      body: "Hi Alex,\n\nThe review is ready for Friday. Does 10 am work?\n\nThanks",
    },
    metadata: [{ label: "Reply-to", value: "replies@example.test" }],
    editable: ["to", "cc", "bcc", "subject", "body"],
  };
}

async function setup(page: Page, draft = initialDraft()) {
  let current = OutgoingMessageDraftSchema.parse(draft);
  const requests: Array<{ procedure: string; input: Record<string, any> }> = [];
  let reject: string | null = null;
  let gate: Promise<void> | undefined;
  let release = () => {};
  // Fail closed: no test request can reach a real API, including an unexpected RPC.
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.replace("/rpc/", "");
    const input = route.request().postDataJSON()?.json ?? {};
    if (procedure === "threads/get") {
      await route.fulfill({
        json: {
          json: {
            threadId: "thread",
            cursor: 1,
            olderCursor: null,
            run: {
              id: "run",
              botId: "bot",
              threadId: "thread",
              taskId: "task",
              status: "waiting_input",
              trigger: "user",
              routineId: null,
              modelProvider: null,
              modelId: null,
              error: null,
              startedAt: null,
              completedAt: null,
              createdAt: "2026-01-01T00:00:00Z",
            },
            messages: [
              {
                id: "draft-message",
                threadId: "thread",
                seq: 1,
                role: "bot",
                botId: "bot",
                runId: "run",
                createdAt: "2026-01-01T00:00:00Z",
                blocks: [
                  {
                    kind: "ask",
                    text: "Generic approval must not render",
                    detail: "Non-authoritative preview",
                    approvalEffectId: "effect",
                    status: "pending",
                    draft: current,
                    actions: [
                      { id: "send", label: "Send" },
                      { id: "discard", label: "Discard" },
                      { id: "always", label: "Always allow" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      });
      return;
    }
    requests.push({ procedure, input });
    if (gate) await gate;
    const stale =
      procedure === "threads/updateDraft"
        ? input.expectedRevision !== current.revision || input.expectedHash !== current.hash
        : input.expectedDraft?.revision !== current.revision ||
          input.expectedDraft?.hash !== current.hash;
    if (reject || stale || !current.canApprove) {
      const message =
        reject ?? (stale ? "Draft changed; review the latest version" : "Not permitted");
      reject = null;
      await route.fulfill({
        status: 409,
        json: { json: { defined: false, code: "CONFLICT", status: 409, message } },
      });
      return;
    }
    if (procedure === "threads/updateDraft") {
      current = {
        ...current,
        revision: current.revision + 1,
        hash: draftHash(current.revision + 1),
        fields: { ...current.fields, ...input.fields },
      };
      await route.fulfill({ json: { json: { draft: current } } });
    } else if (procedure === "threads/answer" && ["send", "discard"].includes(input.answer)) {
      current = { ...current, status: input.answer === "send" ? "sending" : "discarded" };
      await route.fulfill({ json: { json: { ok: true } } });
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/auth/get-session") {
      return route.fulfill({
        json: {
          user: {
            id: "owner-fixture",
            name: "Fixture owner",
            email: "owner@example.test",
            emailVerified: true,
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
          session: {
            id: "session-fixture",
            userId: "owner-fixture",
            token: "fixture-session",
            expiresAt: "2099-01-01T00:00:00Z",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
        },
      });
    }
    return route.abort("blockedbyclient");
  });
  return {
    requests,
    rejectNext(message: string) {
      reject = message;
    },
    setDraft(value: OutgoingMessageDraft) {
      current = structuredClone(value);
    },
    getDraft() {
      return structuredClone(current);
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release();
      gate = undefined;
    },
  };
}

async function open(page: Page, query = "") {
  await page.goto(`/e2e/fixtures/outgoing-draft.html${query}`);
  await expect(page.getByTestId("outgoing-draft-card")).toBeVisible();
  return page.getByTestId("outgoing-draft-card");
}

async function refresh(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { refreshDraft: () => Promise<void> }).refreshDraft(),
  );
}

test("pending draft uses the actual transcript and shows the complete authoritative payload", async ({
  page,
}) => {
  const draft = initialDraft();
  draft.fields.body = `${"A complete review line.\n".repeat(50)}FINAL BODY LINE`;
  draft.metadata!.push({ label: "Thread", value: `${"long-".repeat(80)}FINAL METADATA` });
  await setup(page, draft);
  const card = await open(page);
  await expect(page.getByTestId("transcript").getByTestId("outgoing-draft-card")).toHaveCount(1);
  await expect(card.getByRole("status")).toHaveText("Awaiting approval");
  for (const recipient of [...draft.fields.to, ...draft.fields.cc!, ...draft.fields.bcc!]) {
    await expect(card.getByText(recipient, { exact: false })).toBeVisible();
  }
  await expect(card.getByText("FINAL BODY LINE", { exact: false })).toHaveText(draft.fields.body);
  await expect(card.getByText("FINAL METADATA", { exact: false })).toHaveText(
    draft.metadata![1]!.value,
  );
  await expect(card.getByText("From", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Generic approval must not render")).toHaveCount(0);
  await expect(page.getByText("Non-authoritative preview")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /Always/ })).toHaveCount(0);
  expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("editing saves all fields with the reviewed revision and sends only the saved revision", async ({
  page,
}) => {
  const mock = await setup(page);
  const card = await open(page);
  await card.getByRole("button", { name: "Edit draft" }).click();
  await card.getByLabel("To", { exact: true }).fill("new@example.test\nsecond@example.test");
  await card.getByLabel("CC", { exact: true }).fill("copy@example.test");
  await card.getByLabel("BCC", { exact: true }).fill("hidden@example.test");
  await card.getByLabel("Subject", { exact: true }).fill("Updated subject");
  await card.getByLabel("Message", { exact: true }).fill("Updated complete body");
  await expect(card.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Updated complete body", { exact: true })).toBeVisible();
  expect(mock.requests[0]).toEqual({
    procedure: "threads/updateDraft",
    input: {
      botId: "bot",
      runId: "run",
      messageId: "draft-message",
      approvalEffectId: "effect",
      expectedRevision: 1,
      expectedHash: draftHash(1),
      fields: {
        to: ["new@example.test", "second@example.test"],
        cc: ["copy@example.test"],
        bcc: ["hidden@example.test"],
        subject: "Updated subject",
        body: "Updated complete body",
      },
    },
  });
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Sending");
  expect(mock.requests[1]?.input.expectedDraft).toEqual({ revision: 2, hash: draftHash(2) });
  await expect(card.getByText("Sent", { exact: true })).toHaveCount(0);
});

test("failed edits preserve fields and can be saved after the error", async ({ page }) => {
  const mock = await setup(page);
  const card = await open(page);
  await card.getByRole("button", { name: "Edit draft" }).click();
  await card.getByLabel("To", { exact: true }).fill("kept@example.test");
  await card.getByLabel("Subject").fill("Keep this subject");
  await card.getByLabel("Message", { exact: true }).fill("Keep this unsaved body");
  mock.rejectNext("Could not save draft");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Could not save draft");
  await expect(card.getByLabel("To", { exact: true })).toHaveValue("kept@example.test");
  await expect(card.getByLabel("Subject")).toHaveValue("Keep this subject");
  await expect(card.getByLabel("Message", { exact: true })).toHaveValue("Keep this unsaved body");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Keep this unsaved body", { exact: true })).toBeVisible();
});

test("discard uses expected revision and leaves a read-only discarded card", async ({ page }) => {
  const mock = await setup(page);
  const card = await open(page);
  await card.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Discarded");
  expect(mock.requests).toEqual([
    {
      procedure: "threads/answer",
      input: {
        botId: "bot",
        runId: "run",
        messageId: "draft-message",
        answer: "discard",
        expectedDraft: { revision: 1, hash: draftHash(1) },
      },
    },
  ]);
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("double click sends once and only a confirmed backend result becomes Sent", async ({
  page,
}) => {
  const mock = await setup(page);
  mock.hold();
  const card = await open(page);
  const send = card.getByRole("button", { name: "Send", exact: true });
  await send.evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect.poll(() => mock.requests.length).toBe(1);
  await expect(send).toBeDisabled();
  await expect(card.getByRole("status")).toHaveText("Awaiting approval");
  mock.release();
  await expect(card.getByRole("status")).toHaveText("Sending");
  await expect(card.getByRole("button")).toHaveCount(0);
  mock.setDraft({ ...mock.getDraft(), status: "sent" });
  await refresh(page);
  await expect(card.getByRole("status")).toHaveText("Sent");
  expect(mock.requests).toHaveLength(1);
});

test("stale edit retains local content and requires explicit review of the latest draft", async ({
  page,
}) => {
  const mock = await setup(page);
  const card = await open(page);
  await card.getByRole("button", { name: "Edit draft" }).click();
  await card.getByLabel("Message", { exact: true }).fill("Local unsaved body");
  mock.setDraft({
    ...mock.getDraft(),
    revision: 2,
    hash: draftHash(2),
    fields: { ...mock.getDraft().fields, body: "Latest server body" },
  });
  await refresh(page);
  await expect(card.getByLabel("Message", { exact: true })).toHaveValue("Local unsaved body");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Draft changed; review the latest version");
  await expect(card.getByLabel("Message", { exact: true })).toHaveValue("Local unsaved body");
  expect(mock.requests[0]?.input.expectedRevision).toBe(1);
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByText("Latest server body", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Edit draft" }).click();
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(mock.requests[1]?.input.expectedRevision).toBe(2);
});

test("stale send fails without claiming delivery or changing the reviewed content", async ({
  page,
}) => {
  const mock = await setup(page);
  const card = await open(page);
  mock.setDraft({ ...mock.getDraft(), revision: 2, hash: draftHash(2) });
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Draft changed; review the latest version");
  await expect(card.getByRole("status")).toHaveText("Awaiting approval");
  await expect(card.getByText(initialDraft().fields.body, { exact: true })).toBeVisible();
  expect(mock.requests[0]?.input.expectedDraft).toEqual({ revision: 1, hash: draftHash(1) });
});

for (const [status, label] of Object.entries({
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  uncertain: "Delivery uncertain",
  discarded: "Discarded",
  unavailable: "Unavailable",
})) {
  test(`${status} is a truthful read-only backend state`, async ({ page }) => {
    const draft = {
      ...initialDraft(),
      status: status as OutgoingMessageDraft["status"],
      error: status === "failed" ? "Delivery was rejected" : undefined,
    };
    await setup(page, draft);
    const card = await open(page);
    await expect(card.getByRole("status")).toHaveText(label);
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(card.getByRole("textbox")).toHaveCount(0);
    if (draft.error) await expect(card.getByRole("alert")).toHaveText(draft.error);
  });
}

test("shared draft state never grants a different signed-in user approval rights", async ({
  page,
}) => {
  const mock = await setup(page, { ...initialDraft(), ownerUserId: "another-owner" });
  const card = await open(page);
  await expect(card.getByRole("status")).toHaveText("Awaiting approval");
  await expect(card.getByRole("button", { name: "Edit draft" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
  expect(mock.requests).toHaveLength(0);
});

test("a viewer without approval permission cannot edit, send, or discard", async ({ page }) => {
  const mock = await setup(page, { ...initialDraft(), canApprove: false });
  const card = await open(page);
  await expect(card.getByRole("status")).toHaveText("Awaiting approval");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(mock.requests).toHaveLength(0);
});

test("group draft actions retain the group target", async ({ page }) => {
  const mock = await setup(page);
  const card = await open(page, "?group");
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Sending");
  expect(mock.requests[0]?.input.groupId).toBe("group");
  expect(mock.requests[0]?.input.botId).toBeUndefined();
});

test("calls require on-screen draft review and never start dictation for approval", async ({
  page,
}, testInfo) => {
  const mock = await setup(page);
  await page.goto("/e2e/fixtures/outgoing-draft.html?call");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Review the draft in chat.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Listening…", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Interrupt", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as unknown as { microphoneStarts: () => number }).microphoneStarts(),
    ),
  ).toBe(0);
  expect(mock.requests).toHaveLength(0);
  await captureScreenshot(page, testInfo, "outgoing-draft-call-review");
  await dialog.getByRole("button", { name: "Hang up", exact: true }).click();
  await expect(
    page.getByTestId("outgoing-draft-card").getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
});

test("an inactive ask cannot be approved", async ({ page }) => {
  const mock = await setup(page);
  const card = await open(page, "?readonly");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(mock.requests).toHaveLength(0);
});

test("compact narrow and dark cards display the authentic account without horizontal overflow", async ({
  page,
}, testInfo) => {
  const draft = {
    ...initialDraft(),
    account: { connector: "email", label: "sender@example.test" },
  };
  await setup(page, draft);
  await page.setViewportSize({ width: 390, height: 844 });
  const card = await open(page);
  await expect(card.getByText("sender@example.test", { exact: true })).toBeVisible();
  expect((await card.boundingBox())!.width).toBeGreaterThan(340);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await card.hover();
  expect(
    await page.getByTestId("transcript").evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "outgoing-draft-narrow");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await captureScreenshot(page, testInfo, "outgoing-draft-narrow-dark");
  await card.getByRole("button", { name: "Edit draft" }).click();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByTestId("transcript").evaluate((node) => {
    node.scrollTop = 0;
  });
  await captureScreenshot(page, testInfo, "outgoing-draft-edit-dark-320");
  await card
    .getByLabel("Message", { exact: true })
    .fill(`A long unbroken value: ${"review".repeat(100)}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
});
