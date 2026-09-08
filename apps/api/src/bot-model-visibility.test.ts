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

function fixture() {
  const prisma = {
    $transaction: vi.fn(
      async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(prisma),
    ),
    user: {
      findUnique: vi.fn(async () => ({
        modelVisibility: { hide: [{ provider: "openai-compatible" }] },
      })),
    },
    bot: { update: vi.fn(async () => bot) },
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
      env: {},
      secrets: {},
      sandbox: {},
      home: {},
      events: { notify: vi.fn(async () => undefined) },
      jobs: {},
    } as unknown as RouterDeps),
    { context: { actor: { userId: "owner", spaceId: "space" } as Actor } },
  );
  return { prisma, client };
}

describe("bot pin visibility route", () => {
  it("rejects hidden custom/default targets before credential lookup or mutation", async () => {
    const f = fixture();
    await expect(
      f.client.bots.update({
        botId: "bot",
        modelProvider: "openai-compatible",
        modelId: "another-custom",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("hidden") });
    expect(f.prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
  });
  it.each([
    { title: "New title" },
    { instructions: "New instructions" },
    { title: "New title", modelProvider: "openai-compatible", modelId: "custom-default" },
  ])("allows unrelated edits without reselecting an unchanged hidden pin: %j", async (update) => {
    const f = fixture();
    await expect(f.client.bots.update({ botId: "bot", ...update })).resolves.toMatchObject(bot);
    expect(f.prisma.bot.update).toHaveBeenCalledOnce();
    expect(f.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
