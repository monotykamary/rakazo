import type { AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { type MachineAssignmentResult, machineAssignment, type PrismaClient } from "@rakazo/db";
import { MachineRelocationError, relocateBotMachine } from "./machine-relocation.js";

export interface MachineAssignDeps {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  /**
   * Kind for default (unassign) computer rows created by relocation, derived
   * from the deployment sandbox configuration. Defaults to "docker".
   */
  defaultComputerKind?: string;
  assertMoveClaim?: () => void;
}

/**
 * machines.assign: point a bot at a user-owned machine (or back to a default)
 * under the same computerSwitching latch the setComputer flow uses, so runs
 * cannot start mid-move. Every move is a verified relocation: the source
 * workspace is checkpointed, copied to a distinct target home key, verified
 * against a manifest, and only then atomically committed; the source is
 * retired gracefully and kept until the copy is proven. Queued dispatched-work
 * bindings keep their old placement and hold instead of rebinding.
 */
export async function assignBotMachine(
  deps: MachineAssignDeps,
  actor: Actor,
  input: {
    botId: string;
    machineId: string | null;
    expectedComputerId?: string | null;
    intentId?: string;
    intentClaimToken?: string;
  },
): Promise<MachineAssignmentResult> {
  const { prisma } = deps;
  if (input.intentId && !input.intentClaimToken)
    throw new MachineRelocationError("CONFLICT", { message: "Move claim required" });
  // Existence is checked before the latch so a foreign or unknown bot reads as
  // NOT_FOUND instead of a latch conflict that would leak its state.
  const owned = await prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!owned) throw new MachineRelocationError("NOT_FOUND");
  deps.assertMoveClaim?.();
  const claim = async (tx: Pick<PrismaClient, "bot" | "officeMoveIntent">) => {
    const claimed = await tx.bot.updateMany({
      where: {
        id: input.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        computerSwitching: false,
        ...(input.expectedComputerId !== undefined ? { computerId: input.expectedComputerId } : {}),
      },
      data: {
        computerSwitching: true,
        ...(input.intentId ? { officeMoveIntentId: input.intentId } : {}),
      },
    });
    if (claimed.count !== 1) throw new MachineRelocationError("CONFLICT");
    if (input.intentId) {
      const claimedIntent = await tx.officeMoveIntent.updateMany({
        where: { id: input.intentId, status: "pending" },
        data: { status: "processing", claimToken: input.intentClaimToken },
      });
      if (claimedIntent.count !== 1) throw new MachineRelocationError("CONFLICT");
    }
  };
  if (input.intentId) await prisma.$transaction(claim);
  else await claim(prisma);
  try {
    const bot = await prisma.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
      include: { computer: true },
    });
    if (!bot) throw new MachineRelocationError("NOT_FOUND");
    if (
      input.intentId &&
      (await prisma.run.findFirst({
        where: {
          botId: input.botId,
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
        select: { id: true },
      }))
    )
      throw new MachineRelocationError("CONFLICT", { message: "Active work appeared" });
    const unchangedAssignment = async () => {
      const result = await machineAssignment(prisma, actor, { botId: bot.id });
      if (input.intentId)
        await prisma.$transaction(async (tx) => {
          const completed = await tx.officeMoveIntent.updateMany({
            where: { id: input.intentId, status: "processing", claimToken: input.intentClaimToken },
            data: { status: "completed", resultComputerId: result.computerId },
          });
          if (completed.count !== 1) throw new MachineRelocationError("CONFLICT");
          deps.assertMoveClaim?.();
          await tx.bot.updateMany({
            where: { id: bot.id, officeMoveIntentId: input.intentId },
            data: { computerSwitching: false, officeMoveIntentId: null },
          });
        });
      return result;
    };
    const current = bot.computer;
    if (
      input.expectedComputerId !== undefined &&
      (current?.id ?? null) !== input.expectedComputerId
    )
      throw new MachineRelocationError("CONFLICT", { message: "Source assignment changed" });
    if (input.machineId !== null) {
      const machine = await prisma.machine.findFirst({
        where: {
          id: input.machineId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          status: "paired",
        },
        select: { id: true },
      });
      if (!machine) throw new MachineRelocationError("NOT_FOUND");
      if (current?.machineId === machine.id) {
        return await unchangedAssignment();
      }
      return await relocateBotMachine(
        {
          prisma,
          sandbox: deps.sandbox,
          home: deps.home,
          defaultComputerKind: deps.defaultComputerKind,
          intentId: input.intentId,
          intentClaimToken: input.intentClaimToken,
          assertMoveClaim: deps.assertMoveClaim,
        },
        actor,
        { botId: bot.id, current, machineId: machine.id },
      );
    }
    if (!current?.machineId) {
      return await unchangedAssignment();
    }
    return await relocateBotMachine(
      {
        prisma,
        sandbox: deps.sandbox,
        home: deps.home,
        defaultComputerKind: deps.defaultComputerKind,
        intentId: input.intentId,
        intentClaimToken: input.intentClaimToken,
        assertMoveClaim: deps.assertMoveClaim,
      },
      actor,
      { botId: bot.id, current, machineId: null },
    );
  } finally {
    await prisma.bot.updateMany({
      where: { id: input.botId, ...(input.intentId ? { officeMoveIntentId: input.intentId } : {}) },
      data: { computerSwitching: false, ...(input.intentId ? { officeMoveIntentId: null } : {}) },
    });
  }
}
