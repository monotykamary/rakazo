import type { Actor } from "@rakazo/contracts";
import { COORDINATOR_INSTRUCTIONS, COORDINATOR_OPENING } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { promptFocus, startOnboarding } from "./onboarding.js";

const actor: Actor = {
  userId: "user",
  spaceId: "space",
  email: "test@example.com",
  isDeploymentOwner: false,
};
function harness(instructions = COORDINATOR_INSTRUCTIONS) {
  const tx = {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    message: { create: vi.fn().mockResolvedValue({ id: "opening" }) },
    event: { create: vi.fn().mockResolvedValue({ seq: 1 }) },
  };
  const bot = { id: "chief", instructions, thread: { id: "thread" } };
  const prisma = {
    bot: { findFirst: vi.fn().mockResolvedValue(bot) },
    message: { count: vi.fn().mockResolvedValue(0) },
    user: { findUnique: vi.fn().mockResolvedValue({ name: "Test" }) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return {
    tx,
    prisma,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      events: { notify: vi.fn() } as unknown as ThreadEvents,
    },
  };
}

describe("coordinator onboarding", () => {
  it("uses the stored shared prompt and asks one relevant question, not a template", async () => {
    const h = harness();
    await startOnboarding(h.deps, actor, "chief");
    expect(h.tx.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        blocks: [{ kind: "text", text: COORDINATOR_OPENING }],
      }),
    });
    await promptFocus(h.deps, actor, "chief");
    expect(h.tx.message.create).toHaveBeenCalledOnce();
    expect(h.prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "chief", spaceId: "space", userId: "user" } }),
    );
  });

  it("does not repeat onboarding after the conversation started", async () => {
    const h = harness();
    h.prisma.message.count.mockResolvedValue(1);
    await startOnboarding(h.deps, actor, "chief");
    expect(h.tx.message.create).not.toHaveBeenCalled();
  });

  it("refuses onboarding outside the owner's space", async () => {
    const h = harness();
    h.prisma.bot.findFirst.mockResolvedValue(null);
    await expect(startOnboarding(h.deps, actor, "other")).rejects.toThrow();
    expect(h.tx.message.create).not.toHaveBeenCalled();
  });
});
