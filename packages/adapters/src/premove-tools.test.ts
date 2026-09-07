import type { Actor, QueueSnapshot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { managePremoveTool } from "./premove-tools.js";

const ports = vi.hoisted(() => ({ listPremoveQueue: vi.fn(), mutatePremoveQueue: vi.fn() }));
vi.mock("@rakazo/db", () => ports);
const actor = { userId: "owner", spaceId: "space" } as Actor;
const scope = { threadId: "thread", botId: "bot", runId: "run", trigger: "user" };
const prisma = {} as PrismaClient;
const snapshot: QueueSnapshot = {
  version: 1,
  sessionId: "session",
  revision: 3,
  rows: [
    {
      id: "row",
      sequence: 1,
      lane: "followUp",
      text: "next",
      images: [{ type: "image", data: "fake-image-data", mimeType: "image/png" }],
    },
  ],
  identity: { nextIdNumber: 2, nextSequence: 2 },
  uncertainRowIds: [],
  paused: false,
  errorHold: false,
  modes: { steer: "all", followUp: "all" },
  gracefulPausePending: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  ports.listPremoveQueue.mockResolvedValue(snapshot);
  ports.mutatePremoveQueue.mockResolvedValue({
    version: 1,
    requestId: "request",
    ok: true,
    snapshot,
  });
});

describe("natural-language queue tool", () => {
  it("is registered once with the shared queue operation schema", () => {
    const tools = builtinAgentTools.filter((tool) => tool.name === "manage_queue");
    expect(tools).toHaveLength(1);
    expect(JSON.stringify(tools[0]!.inputSchema)).toContain("expectedRevision");
    expect(JSON.stringify(tools[0]!.inputSchema)).toContain("graceful-pause");
  });
  it("reads the frozen run scope and omits image bytes without changing stored attachments", async () => {
    const result = await managePremoveTool(
      prisma,
      actor,
      scope,
      { threadId: "foreign", botId: "foreign" },
      "call",
    );
    expect(ports.listPremoveQueue).toHaveBeenCalledWith(prisma, actor, {
      threadId: "thread",
      botId: "bot",
      spaceId: "space",
    });
    expect(JSON.stringify(result)).toContain('"imageCount":1');
    expect(JSON.stringify(result)).not.toContain("fake-image-data");
    expect(snapshot.rows[0]!.images[0]!.data).toBe("fake-image-data");
  });
  it("uses one shared mutation engine with revision and stable effect identity", async () => {
    await managePremoveTool(
      prisma,
      actor,
      scope,
      { expectedRevision: 3, operation: { type: "hold", id: "row", paused: true } },
      "call",
    );
    expect(ports.mutatePremoveQueue).toHaveBeenCalledWith(prisma, actor, {
      threadId: "thread",
      botId: "bot",
      requestId: "agent:run:call",
      expectedRevision: 3,
      operation: { type: "hold", id: "row", paused: true },
    });
  });
  it("never silently overwrites a concurrent user's plan", async () => {
    ports.mutatePremoveQueue.mockResolvedValue({
      version: 1,
      requestId: "request",
      ok: false,
      error: "revision conflict",
      snapshot: { ...snapshot, revision: 4 },
    });
    const result = await managePremoveTool(
      prisma,
      actor,
      scope,
      { expectedRevision: 3, operation: { type: "pause" } },
      "call",
    );
    expect(result).toMatchObject({ ok: false, snapshot: { revision: 4 } });
    expect(ports.mutatePremoveQueue).toHaveBeenCalledOnce();
  });
  it("requires a revision before mutating", async () => {
    await expect(
      managePremoveTool(prisma, actor, scope, { operation: { type: "pause" } }, "call"),
    ).rejects.toThrow("expectedRevision");
    expect(ports.mutatePremoveQueue).not.toHaveBeenCalled();
  });
  it.each(["messaging", "bot_message"])("never leaks private intent into %s", async (trigger) => {
    await expect(
      managePremoveTool(prisma, actor, { ...scope, trigger }, {}, "call"),
    ).rejects.toThrow("unavailable");
    expect(ports.listPremoveQueue).not.toHaveBeenCalled();
    expect(ports.mutatePremoveQueue).not.toHaveBeenCalled();
  });
});
