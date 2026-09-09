import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { enqueueComposerDraft, queueDraftError } from "./composer-queue";

const snapshot = {
  version: 1,
  sessionId: "session",
  revision: 7,
  rows: [],
  identity: { nextIdNumber: 1, nextSequence: 1 },
  uncertainRowIds: [],
  paused: false,
  errorHold: false,
  modes: { steer: "all", followUp: "all" },
  gracefulPausePending: false,
};
const base = {
  threadId: "thread",
  botId: "bot",
  lane: "steer" as const,
  text: "hello",
  attachments: [],
  requestId: "request",
};
function client(ok = true) {
  let id = 0;
  return vi.fn(async (path: string, _input: Record<string, unknown>): Promise<unknown> => {
    if (path === "artifacts/create") return { id: `artifact-${++id}` };
    if (path === "queue/list") return snapshot;
    return {
      version: 1,
      requestId: "request",
      ok,
      error: ok ? undefined : "Revision conflict",
      snapshot,
    };
  });
}
describe("native composer queue", () => {
  it.each(["steer", "followUp"] as const)(
    "enqueues %s with explicit scope and fresh revision",
    async (lane) => {
      const rpc = client();
      await enqueueComposerDraft({ ...base, lane, rpc });
      expect(rpc.mock.calls).toEqual([
        ["queue/list", { threadId: "thread", botId: "bot" }],
        [
          "queue/mutate",
          {
            threadId: "thread",
            botId: "bot",
            expectedRevision: 7,
            requestId: "request",
            operation: { type: "enqueue", lane, text: "hello" },
          },
        ],
      ]);
    },
  );
  it("uploads images and documents through the ordinary group artifact target", async () => {
    const rpc = client();
    const attachments = [
      { name: "image.png", mimeType: "image/png", contentBase64: "aW1hZ2U=" },
      { name: "note.pdf", mimeType: "application/pdf", contentBase64: "ZG9j" },
    ];
    await enqueueComposerDraft({ ...base, text: "", groupId: "group", attachments, rpc });
    expect(rpc.mock.calls[0]).toEqual([
      "artifacts/create",
      { groupId: "group", ...attachments[0] },
    ]);
    expect(rpc.mock.calls[1]).toEqual([
      "artifacts/create",
      { groupId: "group", ...attachments[1] },
    ]);
    expect(rpc.mock.calls[3]?.[1]).toMatchObject({
      botId: "bot",
      threadId: "thread",
      operation: { text: "", artifactIds: ["artifact-1", "artifact-2"] },
    });
  });
  it("does not treat a conflict or failed upload as success", async () => {
    await expect(enqueueComposerDraft({ ...base, rpc: client(false) })).rejects.toThrow(
      "Revision conflict",
    );
    const rpc = vi.fn().mockRejectedValue(new Error("Upload failed"));
    await expect(
      enqueueComposerDraft({
        ...base,
        rpc,
        attachments: [{ name: "a", mimeType: "image/png", contentBase64: "YQ==" }],
      }),
    ).rejects.toThrow("Upload failed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported intent explicitly", () => {
    expect(queueDraftError(0, false)).toBeNull();
    expect(queueDraftError(1, false)).toBe("Remove mentions before queueing.");
    expect(queueDraftError(0, true)).toBe("Remove reply before queueing.");
    expect(queueDraftError(1, true)).toBe("Remove mentions and reply before queueing.");
  });
  it("keeps native presentation bounded and uses the existing model and send sheets", () => {
    const thread = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
    const queue = readFileSync(new URL("../components/QueueStrip.tsx", import.meta.url), "utf8");
    const model = readFileSync(
      new URL("../components/ModelSelectionControl.tsx", import.meta.url),
      "utf8",
    );
    expect(thread).toContain("onLongPress={showSendActions}");
    expect(thread).toContain("maxHeight: 120");
    expect(queue).toContain("rows.slice(0, 2)");
    expect(queue).toContain("numberOfLines={1}");
    expect(queue).not.toContain("Add queued message");
    expect(queue).toContain("Resume uncertain deliveries?");
    expect(thread.indexOf("<ModelSelectionControl")).toBeLessThan(
      thread.indexOf('ios="desktopcomputer"'),
    );
    expect(model).toContain('"models/setWorkerSelection"');
    expect(model).not.toContain('"models/setSelection"');
  });
});
