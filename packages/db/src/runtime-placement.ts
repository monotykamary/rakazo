import type { QueuePlacement } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import type { RuntimeSessionScope } from "./runtime-sessions.js";
import { IsolationError } from "./scope.js";

type Scope = Pick<RuntimeSessionScope, "spaceId" | "threadId" | "botId">;
const key = (scope: Scope) => ({
  spaceId: scope.spaceId,
  threadId: scope.threadId,
  botId: scope.botId,
});

export async function captureQueuePlacement(
  tx: Prisma.TransactionClient,
  scope: Scope,
): Promise<QueuePlacement> {
  const bot = await tx.bot.findFirst({
    where: { id: scope.botId, spaceId: scope.spaceId, archivedAt: null },
    select: { computer: { select: { id: true, homeKey: true } } },
  });
  if (!bot) throw new IsolationError();
  const computer = bot.computer;
  const empty: QueuePlacement = {
    version: 1,
    kind: computer ? "unbound" : "none",
    computerId: computer?.id ?? null,
    homeKey: computer?.homeKey ?? null,
    projectPath: null,
    worktreePath: null,
    revision: 0,
  };
  if (!computer) return empty;
  const row = await tx.runtimePlacement.findUnique({
    where: { spaceId_threadId_botId: key(scope) },
  });
  if (!row || row.computerId !== computer.id || row.homeKey !== computer.homeKey) return empty;
  return {
    version: 1,
    kind: "project",
    computerId: row.computerId,
    homeKey: row.homeKey,
    projectPath: row.projectPath,
    worktreePath: row.worktreePath,
    revision: row.revision,
  };
}

/** Called only after the backend provider authorizes a known project/worktree; never exposed as raw client cwd RPC. */
export async function setRuntimePlacement(
  prisma: PrismaClient,
  scope: RuntimeSessionScope,
  placement: { computerId: string; homeKey: string; projectPath: string; worktreePath?: string },
  authorize: (candidate: Readonly<typeof placement>) => Promise<void>,
): Promise<void> {
  for (const path of [placement.projectPath, placement.worktreePath].filter(
    (value): value is string => value !== undefined,
  )) {
    if (
      !path.trim() ||
      path.length > 4096 ||
      path.includes("\0") ||
      path.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid project placement");
  }
  const frozen = Object.freeze({ ...placement });
  await authorize(frozen);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${scope.threadId} AND "spaceId" = ${scope.spaceId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: scope.runId,
        ...key(scope),
        status: "running",
        leaseOwner: scope.leaseOwner,
        leaseFence: scope.leaseFence,
        leaseExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    const bot = await tx.bot.findFirst({
      where: {
        id: scope.botId,
        spaceId: scope.spaceId,
        computerId: placement.computerId,
        computer: { homeKey: placement.homeKey },
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!run || !bot) throw new Error("Runtime placement authority changed");
    await tx.runtimePlacement.upsert({
      where: { spaceId_threadId_botId: key(scope) },
      create: { ...key(scope), ...frozen },
      update: { ...frozen, worktreePath: frozen.worktreePath ?? null, revision: { increment: 1 } },
    });
  });
}

/**
 * A queued row may differ from the live conversation's project, but never from its
 * authorized computer. An unbound placement captured with a computer is the authorized
 * root-workspace binding: queued work resolves there at dispatch without a manual project
 * pick. A placement whose computer changed is held — explicit rebinding only.
 */
export async function assertQueuePlacementComputer(
  prisma: PrismaClient,
  scope: Scope,
  placement: QueuePlacement,
): Promise<void> {
  const computerId = placement.computerId;
  const bot = await prisma.bot.findFirst({
    where: {
      id: scope.botId,
      spaceId: scope.spaceId,
      archivedAt: null,
      // A row without a computer only ever dispatches while the bot still has none.
      ...(computerId ? { computerId } : { computerId: null }),
      ...(placement.homeKey ? { computer: { homeKey: placement.homeKey } } : {}),
    },
    select: { id: true },
  });
  if (!bot) throw new Error("Queued intent computer changed; explicit rebinding is required");
}
