import { appendEventInTransaction, type Prisma, type PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export class BotComputerSwitchingError extends Error {
  constructor() {
    super("Model selection cannot change while the bot is moving");
    this.name = "BotComputerSwitchingError";
  }
}

type AppendEvent = typeof appendEventInTransaction;

/**
 * Persist a bot row. When profile labels change, write `bot.updated` in the same
 * transaction so clients never observe a successful rename without a durable event.
 * Realtime notify stays best-effort after commit.
 */
export async function commitBotUpdate(
  options: {
    prisma: PrismaClient;
    notify: (threadId: string, seq: number) => Promise<void>;
    spaceId: string;
    threadId: string;
    botId: string;
    data: Prisma.BotUncheckedUpdateInput;
    emitBotUpdated: boolean;
    requireStableComputer?: boolean;
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<{ id: string; name: string; title: string; description: string }> {
  if (!options.emitBotUpdated && !options.requireStableComputer) {
    return options.prisma.bot.update({
      where: { id: options.botId },
      data: options.data,
      select: { id: true, name: true, title: true, description: true },
    });
  }

  const committed = await options.prisma.$transaction(async (tx) => {
    if (options.requireStableComputer) {
      const locked = await tx.$queryRaw<Array<{ computerSwitching: boolean }>>`
        SELECT "computerSwitching" FROM bots WHERE id = ${options.botId} FOR UPDATE
      `;
      if (locked[0]?.computerSwitching !== false) throw new BotComputerSwitchingError();
    }
    const updated = await tx.bot.update({
      where: { id: options.botId },
      data: options.data,
      select: { id: true, name: true, title: true, description: true },
    });
    if (!options.emitBotUpdated) return { updated, seq: null };
    const event = await appendEvent(tx, {
      spaceId: options.spaceId,
      threadId: options.threadId,
      botId: options.botId,
      type: "bot.updated",
      payload: {
        botId: updated.id,
        name: updated.name,
        title: updated.title,
        description: updated.description,
      },
    });
    return { updated, seq: event.seq };
  });

  if (committed.seq !== null)
    await options.notify(options.threadId, committed.seq).catch((error) => {
      getLogger().error("bot.updated realtime notification", error);
    });
  return committed.updated;
}

export function botProfileLabelsChanged(input: {
  name?: unknown;
  title?: unknown;
  description?: unknown;
}): boolean {
  return input.name !== undefined || input.title !== undefined || input.description !== undefined;
}
