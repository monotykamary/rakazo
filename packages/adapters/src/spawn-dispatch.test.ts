import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import * as db from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as messaging from "./bot-messages.js";
import { spawnBot } from "./child-bots.js";

const source = {
  id: "source-run",
  spaceId: "space",
  botId: "chief",
  userId: "owner",
  threadId: "control-thread",
  sourceMessageId: null,
};
const input = {
  spawnedBy: { id: "chief", name: "Chief", spaceId: "space", userId: "owner" },
  runId: source.id,
  spawnKey: "creation-call",
  name: "Builder",
  instructions: "Build the API. Do not edit the UI.",
  prompt: "Implement the scoped API and report checks.",
};
function harness() {
  const createBot = vi
    .fn()
    .mockResolvedValue({ id: "builder", name: "Builder", title: "", threadId: "builder-thread" });
  vi.spyOn(db, "createRepos").mockReturnValue({ createBot } as unknown as ReturnType<
    typeof db.createRepos
  >);
  const send = vi.spyOn(messaging, "messageBot").mockResolvedValue({
    ok: true,
    botId: "builder",
    name: "Builder",
    delivered: input.prompt,
    note: "Queued",
    threadId: "builder-thread",
    runId: "worker-run",
    taskId: "worker-task",
  });
  const prisma = {
    run: {
      findFirst: vi.fn().mockResolvedValue(source),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    bot: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return {
    createBot,
    send,
    prisma,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      jobs: { enqueue: vi.fn() } as unknown as JobPublisher,
      events: { notify: vi.fn() },
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("spawn first-task dispatch", () => {
  it("uses the durable peer queue rather than waiting on an in-process helper", async () => {
    const h = harness();
    const result = await spawnBot(h.deps, input);
    expect(h.createBot).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner", spaceId: "space" }),
      expect.objectContaining({ instructions: input.instructions, parentBotId: "chief" }),
    );
    expect(h.send).toHaveBeenCalledWith(h.deps, source, input.spawnedBy, {
      bot_id: "builder",
      message: input.prompt,
      intent: "request",
      deliveryKey: "spawn:creation-call",
    });
    expect(result).toMatchObject({
      ok: true,
      task: { runId: "worker-run", taskId: "worker-task" },
    });
  });

  it("reuses both creation and dispatch keys after a crash between those steps", async () => {
    const h = harness();
    h.createBot.mockRejectedValue(new Error("duplicate"));
    h.prisma.bot.findUnique.mockResolvedValue({
      id: "builder",
      name: "Builder",
      title: "",
      thread: { id: "builder-thread" },
      userId: "owner",
      parentBotId: "chief",
      archivedAt: null,
    });
    expect(await spawnBot(h.deps, input)).toMatchObject({ ok: true, duplicate: true });
    expect(h.send.mock.calls[0]?.[3].deliveryKey).toBe("spawn:creation-call");
  });

  it.each(["userId", "parentBotId", "archivedAt"])(
    "refuses an unavailable replay target: %s",
    async (field) => {
      const h = harness();
      h.createBot.mockRejectedValue(new Error("duplicate"));
      h.prisma.bot.findUnique.mockResolvedValue({
        id: "builder",
        thread: { id: "builder-thread" },
        userId: "owner",
        parentBotId: "chief",
        archivedAt: null,
        [field]: field === "archivedAt" ? new Date(0) : "other",
      });
      expect(await spawnBot(h.deps, input)).toMatchObject({
        error: expect.stringContaining("scope"),
      });
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it("does not provision after the source run lost authority", async () => {
    const h = harness();
    h.prisma.run.findFirst.mockResolvedValue(null);
    expect(await spawnBot(h.deps, input)).toMatchObject({
      error: "Source run is no longer active.",
    });
    expect(h.createBot).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
});
