import type { Actor } from "@rakazo/contracts";
import { COORDINATOR_INSTRUCTIONS } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "test@example.com",
  isDeploymentOwner: false,
};
function harness(count: number) {
  const bot = {
    id: "bot",
    name: "Chief",
    title: "",
    description: "",
    instructions: "",
    spaceId: "space",
    color: "ink",
    notifyOnFinish: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    thread: { id: "thread" },
    computer: null,
  };
  const tx = {
    bot: {
      aggregate: vi.fn().mockResolvedValue({ _max: { position: null } }),
      create: vi.fn().mockResolvedValue(bot),
      findFirstOrThrow: vi.fn().mockResolvedValue(bot),
    },
    computer: { upsert: vi.fn().mockResolvedValue({ id: "computer" }) },
    thread: { create: vi.fn().mockResolvedValue({ id: "thread" }) },
    browserProfile: { create: vi.fn() },
    memoryDocument: { create: vi.fn() },
  };
  const prisma = {
    bot: { count: vi.fn().mockResolvedValue(count), findFirst: vi.fn().mockResolvedValue(bot) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { tx, repos: createRepos(prisma as unknown as PrismaClient) };
}
const input = { name: "Chief", title: "", description: "", instructions: "", notifyOnFinish: true };

describe("first bot provisioning", () => {
  it("stores the shared builder prompt on an unconfigured first bot", async () => {
    const h = harness(0);
    await h.repos.createBot(actor, input);
    expect(h.tx.bot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ instructions: COORDINATOR_INSTRUCTIONS }),
    });
  });
  it.each([
    { count: 0, instructions: "Only summarize documents.", parentBotId: undefined },
    { count: 1, instructions: "", parentBotId: undefined },
    { count: 0, instructions: "", parentBotId: "parent" },
  ])(
    "preserves explicit and specialist instructions: %j",
    async ({ count, instructions, parentBotId }) => {
      const h = harness(count);
      await h.repos.createBot(actor, { ...input, instructions, parentBotId });
      expect(h.tx.bot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ instructions }),
      });
    },
  );
});
