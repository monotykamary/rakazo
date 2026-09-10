import { expect, type Page, test } from "@playwright/test";
import type { QueueMutation, QueueSnapshot } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

test("composer glyph morphs without delaying actions or moving the button", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockQueue(page, 0);
  await page.goto("/e2e/fixtures/composer-queue.html");
  await page.getByRole("combobox", { name: "Message Fixture Bot" }).fill("morph preview");
  const icon = page.locator("[data-composer-icon]");
  const path = icon.locator(":scope > path").first();
  const original = await path.getAttribute("d");
  const box = await icon.boundingBox();
  await icon.evaluate((node) => {
    node.setAttribute("data-retained", "true");
  });
  await page.keyboard.down("Alt");
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeEnabled();
  const frames = await path.evaluate(async (node) => {
    const values = new Set<string | null>();
    for (let frame = 0; frame < 12; frame++) {
      await new Promise(requestAnimationFrame);
      values.add(node.getAttribute("d"));
    }
    return [...values];
  });
  expect(frames.length).toBeGreaterThan(1);
  await expect(path).toHaveAttribute("d", "M4 4 C4 4 4 12 8 12 C8 12 20 12 20 12");
  await page.keyboard.up("Alt");
  await page.keyboard.down("Meta");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeEnabled();
  await expect(path).toHaveAttribute("d", "M11 5 C11 5 16 5 16 5 C16 5 21 5 21 5");
  await expect(icon).toHaveAttribute("data-retained", "true");
  expect(await icon.boundingBox()).toEqual(box);
  await captureScreenshot(page, testInfo, "composer-queue-morph");
  await page.keyboard.up("Meta");
  await page.keyboard.down("Alt");
  await page.keyboard.up("Alt");
  await expect(path).toHaveAttribute("d", original!);
});

test("reduced motion switches composer glyphs immediately", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockQueue(page, 0);
  await page.goto("/e2e/fixtures/composer-queue.html");
  await page.getByRole("combobox", { name: "Message Fixture Bot" }).fill("reduced preview");
  const path = page.locator("[data-composer-icon] > path").first();
  await page.keyboard.down("Alt");
  await expect(page.locator('[data-composer-icon="steer"]')).toBeVisible();
  expect(await path.getAttribute("d")).toBe("M4 4 C4 4 4 12 8 12 C8 12 20 12 20 12");
  await page.keyboard.up("Alt");
  await page.keyboard.down("Meta");
  await expect(page.locator('[data-composer-icon="followUp"]')).toBeVisible();
  expect(await path.getAttribute("d")).toBe("M11 5 C11 5 16 5 16 5 C16 5 21 5 21 5");
  await page.keyboard.up("Meta");
});

test("running work morphs the send control into stop", async ({ page }) => {
  await mockQueue(page, 0);
  await page.goto("/e2e/fixtures/composer-queue.html?running");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-composer-icon="stop"]')).toBeVisible();
  await page.keyboard.down("Alt");
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();
  await expect(page.locator('[data-composer-icon="steer"]')).toBeVisible();
  await page.keyboard.up("Alt");
  await page.keyboard.down("Meta");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  await expect(page.locator('[data-composer-icon="followUp"]')).toBeVisible();
  await page.keyboard.up("Meta");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Message Fixture Bot" }).fill("steer later");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.locator('[data-composer-icon="send"]')).toBeVisible();
  await page.getByRole("button", { name: "Choose message action" }).click();
  await expect(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
});

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeSnapshot(count: number): QueueSnapshot {
  return {
    version: 1,
    sessionId: "session",
    revision: 0,
    rows: Array.from({ length: count }, (_, index) => ({
      id: `row-${index + 1}`,
      sequence: index + 1,
      lane: index % 3 === 1 ? ("steer" as const) : ("followUp" as const),
      text:
        index === 0
          ? "Review the changes and keep this concise"
          : index === 1
            ? "Preserve this message in its original queue position when edited"
            : `Queued item ${index + 1} with enough detail to demonstrate a bounded two-line preview without widening the composer`,
      images:
        index === 2 || index === 8
          ? [{ type: "image" as const, mimeType: "image/png" as const, data: pixel }]
          : [],
      attachments:
        index % 4 === 0
          ? [
              {
                artifactId: `artifact-${index}`,
                name: `fixture-${index + 1}.txt`,
                mimeType: "text/plain",
                size: 12,
              },
            ]
          : undefined,
      paused: index === 5 || undefined,
      placement:
        index === 6
          ? {
              version: 1 as const,
              kind: "unbound" as const,
              computerId: null,
              homeKey: null,
              projectPath: null,
              worktreePath: null,
              revision: 0,
            }
          : undefined,
      target: index === 7 ? { participantId: "participant" } : undefined,
    })),
    identity: { nextIdNumber: count + 1, nextSequence: count + 1 },
    uncertainRowIds: count > 9 ? ["row-10"] : [],
    paused: true,
    errorHold: false,
    gracefulPausePending: false,
    modes: { steer: "one-at-a-time", followUp: "one-at-a-time" },
  };
}

async function mockQueue(page: Page, count: number) {
  let snapshot = makeSnapshot(count);
  const operations: QueueMutation["operation"][] = [];
  let rejectNext = false;
  await page.route("**/rpc/queue/list", (route) => route.fulfill({ json: { json: snapshot } }));
  await page.route("**/rpc/queue/mutate", async (route) => {
    const input = route.request().postDataJSON().json as QueueMutation;
    const operation = input.operation;
    if (rejectNext) {
      rejectNext = false;
      await route.fulfill({
        json: {
          json: {
            version: 1,
            requestId: input.requestId,
            ok: false,
            error: "Queue changed; try again",
            snapshot,
          },
        },
      });
      return;
    }
    operations.push(operation);
    snapshot = structuredClone(snapshot);
    snapshot.revision += 1;
    if (operation.type === "edit-begin") {
      snapshot.editing = {
        selectedId: operation.id,
        rows: snapshot.rows.map((row) => ({ ...row, removed: false })),
      };
    }
    if (operation.type === "edit-patch" && snapshot.editing) {
      Object.assign(
        snapshot.editing.rows.find((row) => row.id === snapshot.editing?.selectedId)!,
        operation.patch,
      );
    }
    if (operation.type === "edit-save" && snapshot.editing) {
      snapshot.rows = snapshot.editing.rows.filter((row) => !row.removed);
      delete snapshot.editing;
    }
    if (operation.type === "edit-cancel") delete snapshot.editing;
    if (operation.type === "enqueue") {
      const sequence = snapshot.identity.nextSequence++;
      snapshot.identity.nextIdNumber++;
      snapshot.rows.push({
        id: `row-${sequence}`,
        sequence,
        lane: operation.lane,
        text: operation.text,
        images: operation.images ?? [],
        attachments: operation.artifactIds?.map((artifactId) => ({
          artifactId,
          name: "upload.txt",
          mimeType: "text/plain",
        })),
      });
    }
    await route.fulfill({
      json: { json: { version: 1, requestId: input.requestId, ok: true, snapshot } },
    });
  });
  return {
    operations,
    rejectOnce: () => {
      rejectNext = true;
    },
    snapshot: () => snapshot,
  };
}

test("one queued row stays visually attached to the composer", async ({ page }, testInfo) => {
  await mockQueue(page, 1);
  await page.goto("/e2e/fixtures/composer-queue.html");
  await expect(page.getByTestId("composer-queue")).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue, 1 message" })).toBeVisible();
  await expect(page.getByTestId("composer-bar")).toHaveAttribute("data-queue-attached", "true");
  await captureScreenshot(page, testInfo, "composer-queue-1-desktop");
});

test("three mixed rows remain compact in dark mode", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockQueue(page, 3);
  await page.goto("/e2e/fixtures/composer-queue.html");
  const queue = page.getByTestId("composer-queue");
  await expect(queue.locator("[data-row-id]")).toHaveCount(3);
  await expect(queue.locator('[data-lane="steer"]')).toHaveCount(1);
  await expect(queue.getByText("fixture-1.txt")).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-queue-3-desktop-dark");
});

test("ten rows scroll without covering chat or detaching on a narrow screen", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ colorScheme: "dark" });
  await mockQueue(page, 10);
  await page.goto("/e2e/fixtures/composer-queue.html");
  const queue = page.getByTestId("composer-queue");
  const bar = page.getByTestId("composer-bar");
  await expect(queue.locator("[data-row-id]")).toHaveCount(10);
  await expect(queue.getByLabel("Delivery uncertain")).toBeVisible();
  const queueBox = await queue.boundingBox();
  const barBox = await bar.boundingBox();
  expect(queueBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  expect(queueBox!.height).toBeLessThanOrEqual(300);
  expect(Math.abs(queueBox!.y + queueBox!.height - barBox!.y)).toBeLessThanOrEqual(2);
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(780);
  await captureScreenshot(page, testInfo, "composer-queue-10-narrow-dark");
});

test("modifiers derive the same action for Enter and click and reset on release", async ({
  page,
}) => {
  const queue = await mockQueue(page, 0);
  await page.goto("/e2e/fixtures/composer-queue.html");
  const composer = page.getByRole("combobox", { name: "Message Fixture Bot" });

  await composer.fill("steer with enter");
  await page.keyboard.down("Alt");
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.up("Alt");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  await composer.fill("queue with click");
  await page
    .getByRole("button", { name: "Send", exact: true })
    .evaluate((button) =>
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      ),
    );
  await expect
    .poll(() => queue.operations.filter((operation) => operation.type === "enqueue"))
    .toHaveLength(2);
  await composer.fill("normal send");
  await page.keyboard.press("Enter");

  expect(queue.operations.filter((operation) => operation.type === "enqueue")).toMatchObject([
    { type: "enqueue", lane: "steer", text: "steer with enter" },
    { type: "enqueue", lane: "followUp", text: "queue with click" },
  ]);
  await expect
    .poll(() => page.evaluate(() => window.__composerEvents))
    .toContainEqual({ type: "send", text: "normal send", mentions: [] });

  await page.keyboard.down("Alt");
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await page.keyboard.up("Alt");
});

test("a failed normal send retains its draft and attachment", async ({ page }) => {
  await mockQueue(page, 0);
  await page.goto("/e2e/fixtures/composer-queue.html?attachment&failSend");
  const composer = page.getByRole("combobox", { name: "Message Fixture Bot" });
  await composer.fill("keep this draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("composer-error")).toContainText("Send failed");
  await expect(composer).toHaveValue("keep this draft");
  await expect(page.getByRole("button", { name: "Remove parked.txt" })).toBeVisible();
});

test("Shift+Enter is a newline, composing Enter is inert, and rejection retains the draft", async ({
  page,
}) => {
  const queue = await mockQueue(page, 0);
  await page.goto("/e2e/fixtures/composer-queue.html?attachment");
  const composer = page.getByRole("combobox", { name: "Message Fixture Bot" });
  await composer.fill("first");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second");
  await expect(composer).toHaveValue("first\nsecond");
  await composer.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    ),
  );
  await expect(composer).toHaveValue("first\nsecond");

  queue.rejectOnce();
  await page.getByRole("button", { name: "Send", exact: true }).click({ modifiers: ["Meta"] });
  await expect(page.getByTestId("composer-error")).toContainText("Queue changed; try again");
  await expect(composer).toHaveValue("first\nsecond");
  await expect(page.getByRole("button", { name: "Remove parked.txt" })).toBeVisible();
});

test("group queue actions require an explicit bot and retain ambiguous drafts", async ({
  page,
}) => {
  const queue = await mockQueue(page, 0);
  await page.goto("/e2e/fixtures/composer-queue.html?group");
  const composer = page.getByRole("combobox", { name: "Message Fixture Bot" });
  await composer.fill("target this safely");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByTestId("composer-error")).toContainText("Choose a bot before queueing");
  await expect(composer).toHaveValue("target this safely");
  expect(queue.operations).toHaveLength(0);

  await page.getByRole("button", { name: "Choose message action" }).click();
  await page.getByRole("menuitem", { name: "Queue", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Beta", exact: true }).click();
  await expect
    .poll(() => queue.operations.filter((operation) => operation.type === "enqueue"))
    .toHaveLength(1);
  await expect(composer).toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => window.__composerEvents.at(-1)))
    .toMatchObject({ type: "followUp", text: "target this safely", botId: "beta" });
});

test("touch long-press reveals the same composer action menu", async ({ page }) => {
  await mockQueue(page, 0);
  await page.goto("/e2e/fixtures/composer-queue.html");
  const composer = page.getByRole("combobox", { name: "Message Fixture Bot" });
  await composer.fill("touch queue");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await send.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 1, isPrimary: true });
  await expect(page.getByRole("menuitem", { name: "Queue", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Queue", exact: true }).click();
  await expect(composer).toHaveValue("");
});

test("cancelling a queue edit restores the parked draft and attachment", async ({ page }) => {
  const queue = await mockQueue(page, 3);
  await page.goto("/e2e/fixtures/composer-queue.html?attachment");
  const composer = page.getByRole("combobox", { name: "Message Fixture Bot" });
  await composer.fill("parked draft with attachment");
  await expect(page.getByRole("button", { name: "Remove parked.txt" })).toBeVisible();
  await page.getByRole("button", { name: /Edit queued message: Preserve this message/ }).click();
  await expect(page.getByRole("button", { name: "Remove parked.txt" })).toHaveCount(0);
  await composer.fill("discard this edit");
  await page.keyboard.press("Escape");
  await expect(composer).toHaveValue("parked draft with attachment");
  await expect(page.getByRole("button", { name: "Remove parked.txt" })).toBeVisible();
  expect(queue.snapshot().rows[1]?.text).toBe(
    "Preserve this message in its original queue position when edited",
  );
  expect(queue.operations.map((operation) => operation.type)).toEqual([
    "edit-begin",
    "edit-cancel",
  ]);
});

test("editing uses the same composer and preserves the original queue slot", async ({ page }) => {
  const queue = await mockQueue(page, 3);
  await page.goto("/e2e/fixtures/composer-queue.html");
  const composer = page.getByRole("combobox", { name: "Message Fixture Bot" });
  await composer.fill("parked draft");
  await page.getByRole("button", { name: /Edit queued message: Preserve this message/ }).click();
  await expect(composer).toHaveValue(
    "Preserve this message in its original queue position when edited",
  );
  await expect(page.getByRole("button", { name: "Save queue edit" })).toBeVisible();
  await composer.fill("Second row edited");
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("parked draft");
  expect(queue.snapshot().rows.map((row) => row.text)).toEqual([
    "Review the changes and keep this concise",
    "Second row edited",
    expect.stringContaining("Queued item 3"),
  ]);
  expect(queue.operations.map((operation) => operation.type)).toEqual([
    "edit-begin",
    "edit-patch",
    "edit-save",
  ]);
});

declare global {
  interface Window {
    __composerEvents: Array<{ type: string; text: string; mentions: unknown[]; botId?: string }>;
  }
}
