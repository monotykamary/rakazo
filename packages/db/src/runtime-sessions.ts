import type { Prisma, PrismaClient } from "./client.js";

export interface RuntimeSessionScope {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
}

export class RuntimeSessionConflict extends Error {
  constructor() {
    super("Runtime session lease, generation or revision changed");
  }
}

async function lockScope(tx: Prisma.TransactionClient, scope: RuntimeSessionScope) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} AND "spaceId" = ${scope.spaceId} FOR UPDATE`;
  const run = await tx.run.findFirst({
    where: {
      id: scope.runId,
      spaceId: scope.spaceId,
      threadId: scope.threadId,
      botId: scope.botId,
      status: "running",
      leaseOwner: scope.leaseOwner,
      leaseFence: scope.leaseFence,
      leaseExpiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!run) throw new RuntimeSessionConflict();
  const thread = await tx.thread.findFirst({
    where: { id: scope.threadId, spaceId: scope.spaceId },
    select: { historyCompactionGeneration: true },
  });
  if (!thread) throw new RuntimeSessionConflict();
  return thread.historyCompactionGeneration;
}

/** Opaque private execution state; never expose it through the inspection API. */
export async function createRuntimeSession(prisma: PrismaClient, scope: RuntimeSessionScope) {
  const key = { spaceId: scope.spaceId, threadId: scope.threadId, botId: scope.botId };
  const loaded = await prisma.$transaction(async (tx) => {
    const generation = await lockScope(tx, scope);
    const row = await tx.runtimeSession.findUnique({ where: { spaceId_threadId_botId: key } });
    if (row && row.generation !== generation) throw new RuntimeSessionConflict();
    return { generation, revision: row?.revision ?? 0, state: row?.state };
  });
  let revision = loaded.revision;
  let tail: Promise<void> = Promise.resolve();
  return {
    ...(loaded.state === undefined ? {} : { restore: loaded.state }),
    save(state: unknown): Promise<void> {
      // Serialize callbacks, including checkpoints emitted concurrently by nested runtime work.
      const work = tail.then(async () => {
        const encoded = JSON.stringify(state);
        if (!encoded || encoded.length > 16 * 1024 * 1024)
          throw new Error("Invalid runtime checkpoint size");
        const value = JSON.parse(encoded) as Prisma.InputJsonValue;
        await prisma.$transaction(async (tx) => {
          if ((await lockScope(tx, scope)) !== loaded.generation)
            throw new RuntimeSessionConflict();
          const current = await tx.runtimeSession.findUnique({
            where: { spaceId_threadId_botId: key },
          });
          if (
            (current?.revision ?? 0) !== revision ||
            (current && current.generation !== loaded.generation)
          )
            throw new RuntimeSessionConflict();
          await tx.runtimeSession.upsert({
            where: { spaceId_threadId_botId: key },
            create: { ...key, generation: loaded.generation, revision: revision + 1, state: value },
            update: { revision: revision + 1, state: value },
          });
        });
        revision++;
      });
      tail = work;
      return work;
    },
  };
}
