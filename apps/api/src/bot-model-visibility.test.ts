import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const { bot } = vi.hoisted(() => ({
  bot: {
    id: "bot",
    spaceId: "space",
    name: "Helper",
    title: "Helper",
    description: "",
    instructions: "",
    color: "ink",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: "isolated",
    threadId: "thread",
    preview: "",
    status: "idle",
    computerMode: "team",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    modelProvider: "openai-compatible",
    modelId: "custom-default",
    thinkingLevel: null,
  },
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
  createRepos: () => ({
    getBot: async () => ({ ...bot, thread: { id: "thread" } }),
    listBots: async () => [bot],
  }),
}));

function fixture(owner = false) {
  const piModels = {
    read: vi.fn(),
    validate: vi.fn(async () => {}),
    supportsCheckpoint: vi.fn(() => true),
  };
  const prisma = {
    $transaction: vi.fn(
      async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(prisma),
    ),
    user: {
      findUnique: vi.fn(async () => ({
        modelVisibility: { hide: [{ provider: "openai-compatible" }] },
      })),
    },
    $queryRaw: vi.fn(async () => [{ computerSwitching: false }]),
    thread: { findFirst: vi.fn(async () => ({ id: "thread" })) },
    runtimeSession: { findUnique: vi.fn(async () => ({ state: {} })) },
    bot: { findFirst: vi.fn(async () => bot), update: vi.fn(async () => bot) },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        credential: { id: "connection", provider: "openai-compatible" },
        modelId: "custom-default",
      })),
    },
  };
  const client = createRouterClient(
    createRouter({
      prisma,
      piModels,
      env: {},
      secrets: {},
      sandbox: {},
      home: {},
      events: { notify: vi.fn(async () => undefined) },
      jobs: {},
    } as unknown as RouterDeps),
    {
      context: { actor: { userId: "owner", spaceId: "space", isDeploymentOwner: owner } as Actor },
    },
  );
  return { prisma, client, piModels };
}

describe("bot Pi model intent route", () => {
  it.each([
    { thinkingLevel: "low" as const },
    { thinkingLevel: null },
    { modelProvider: "extension", modelId: "custom" },
  ])("Pi-validates each model intent: %j", async (update) => {
    const f = fixture(true);
    await f.client.bots.update({ botId: "bot", ...update });
    expect(f.piModels.validate).toHaveBeenCalledOnce();
    expect(f.prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(f.prisma.bot.update).toHaveBeenCalledOnce();
    expect(f.prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
  });
  it("blocks a bot model update when moving starts during validation", async () => {
    const f = fixture(true);
    f.piModels.validate.mockImplementation(async () => {
      f.prisma.$queryRaw.mockResolvedValue([{ computerSwitching: true }]);
    });
    await expect(
      f.client.bots.update({ botId: "bot", thinkingLevel: "low" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
  });
  it("clears bot intent without probing but still honors the move latch", async () => {
    const f = fixture(true);
    f.prisma.$queryRaw.mockResolvedValue([{ computerSwitching: true }]);
    await expect(
      f.client.bots.update({
        botId: "bot",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.piModels.validate).not.toHaveBeenCalled();
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
  });

  it("rejects non-owner model intents before credential lookup or mutation", async () => {
    const f = fixture();
    await expect(
      f.client.bots.update({
        botId: "bot",
        modelProvider: "openai-compatible",
        modelId: "another-custom",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
  });
  it.each([{ title: "New title" }, { instructions: "New instructions" }])(
    "allows unrelated edits without reselecting an unchanged hidden pin: %j",
    async (update) => {
      const f = fixture();
      await expect(f.client.bots.update({ botId: "bot", ...update })).resolves.toMatchObject(bot);
      expect(f.prisma.bot.update).toHaveBeenCalledOnce();
      expect(f.prisma.user.findUnique).not.toHaveBeenCalled();
    },
  );
});
