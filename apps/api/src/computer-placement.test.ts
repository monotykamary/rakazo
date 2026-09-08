import { createRouterClient } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const repos = vi.hoisted(() => ({ getBot: vi.fn(), listBots: vi.fn(), setBotComputer: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  createRepos: () => repos,
}));

const bot = {
  id: "bot",
  spaceId: "space",
  name: "Helper",
  title: "",
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
  computerMode: "dedicated",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
};

beforeEach(() => vi.resetAllMocks());

function fixture(kind = "machine", scope = "dedicated") {
  const computer = { id: "current-computer", kind, scope };
  repos.getBot.mockResolvedValue({ ...bot, computer });
  repos.listBots.mockResolvedValue([bot]);
  const prisma = { bot: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
  const client = createRouterClient(
    createRouter({
      prisma,
      secrets: {},
      sandbox: {},
      home: {},
      events: {},
      jobs: {},
    } as unknown as RouterDeps),
    { context: { actor: { userId: "owner", spaceId: "space" } } },
  );
  return { client, prisma };
}

it.each(["machine", "docker"])("preserves %s placement on a sharing no-op", async (kind) => {
  const { client, prisma } = fixture(kind);
  await expect(client.bots.setComputer({ botId: "bot", mode: "dedicated" })).resolves.toMatchObject(
    { id: "bot", computerMode: "dedicated" },
  );
  expect(repos.setBotComputer).not.toHaveBeenCalled();
  expect(prisma.bot.updateMany).not.toHaveBeenCalled();
});

it("refuses changing sharing while paired instead of silently unassigning the machine", async () => {
  const { client, prisma } = fixture();
  await expect(client.bots.setComputer({ botId: "bot", mode: "team" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("default machine"),
  });
  expect(repos.setBotComputer).not.toHaveBeenCalled();
  expect(prisma.bot.updateMany).not.toHaveBeenCalled();
});

it("fences a concurrent placement change before the legacy sharing operation", async () => {
  const { client, prisma } = fixture("docker", "team");
  await expect(client.bots.setComputer({ botId: "bot", mode: "dedicated" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(prisma.bot.updateMany).toHaveBeenCalledWith({
    where: { id: "bot", computerId: "current-computer", computerSwitching: false },
    data: { computerSwitching: true },
  });
  expect(repos.setBotComputer).not.toHaveBeenCalled();
});
