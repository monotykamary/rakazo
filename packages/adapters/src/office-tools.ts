import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { toolRequiresExplicitApproval } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import { machineStatusOf } from "./machine-tunnel.js";
import { inspectOfficeModels, type OfficeModelDeps } from "./office-model-preflight.js";
import { enqueueApprovedOfficeMove } from "./office-move-intents.js";

export const OfficeToolInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect") }).strict(),
  z
    .object({
      action: z.literal("plan"),
      machineId: z.string().min(1).max(128).nullable().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("move"), machineId: z.string().min(1).max(128).nullable() })
    .strict(),
]);

export const MANAGE_OFFICE_TOOL: ConnectorTool = {
  name: "manage_office",
  description:
    "Inspect or plan the bot's office. An explicitly approved managed move queues durable relocation after this run and active workers finish; inspect reports its status. Pair machines manually in secure settings; never provide credentials or pairing codes. Pairing compute does not move the control plane. Pi-local remote assignment is unsupported.",
  inputSchema: z.toJSONSchema(OfficeToolInputSchema),
};

/** Mutations require explicit human approval, not auto-review or an allow rule. */
export function officeActionRequiresExplicitApproval(value: unknown): boolean {
  const parsed = OfficeToolInputSchema.safeParse(value);
  return !parsed.success || toolRequiresExplicitApproval("manage_office", parsed.data);
}

export interface OfficeToolDeps extends OfficeModelDeps {
  prisma: PrismaClient;
  /** Supplied by the trusted composition root, never tool arguments. */
  runtime: string;
}

export interface OfficeToolScope {
  botId: string;
  runId: string;
  leaseOwner: string;
  leaseFence: number;
}

export async function manageOfficeTool(
  deps: OfficeToolDeps,
  actor: Pick<Actor, "spaceId" | "userId">,
  scope: OfficeToolScope,
  value: unknown,
  approvedEffectId?: string,
) {
  const input = OfficeToolInputSchema.parse(value);
  const run = await deps.prisma.run.findFirst({
    where: {
      id: scope.runId,
      botId: scope.botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      leaseOwner: scope.leaseOwner,
      leaseFence: scope.leaseFence,
      leaseExpiresAt: { gt: new Date() },
      status: "running",
    },
    select: { id: true },
  });
  if (!run) throw new Error("Office access unavailable");
  const bot = await deps.prisma.bot.findFirst({
    where: { id: scope.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { computer: { select: { id: true, kind: true, state: true, machineId: true } } },
  });
  if (!bot) throw new Error("Office access unavailable");
  const machines = await deps.prisma.machine.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, status: "paired" },
    select: { id: true, name: true, lastSeenAt: true },
    orderBy: { id: "asc" },
    take: 100,
  });
  if (
    input.action !== "inspect" &&
    input.machineId != null &&
    !machines.some((machine) => machine.id === input.machineId)
  ) {
    throw new Error("Target unavailable; inspect paired machines first");
  }
  const native = deps.runtime === "pi-local";
  if (input.action === "move" && !native && !approvedEffectId)
    throw new Error("Explicit approval receipt required");
  const models = await inspectOfficeModels(
    deps,
    actor,
    scope.botId,
    input.action === "inspect" ? undefined : input.machineId,
  );
  let queuedIntent: { id: string; status: string } | undefined;
  if (input.action === "move" && !native && models.status === "available") {
    if (!approvedEffectId) throw new Error("Explicit approval receipt required");
    queuedIntent = await enqueueApprovedOfficeMove(deps, actor, {
      botId: scope.botId,
      runId: scope.runId,
      approvedEffectId,
      currentComputerId: bot.computer?.id ?? null,
      machineId: input.machineId,
    });
  }
  const moves = await deps.prisma.officeMoveIntent.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, botId: scope.botId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
    select: { id: true, status: true, machineId: true, resultComputerId: true, error: true },
  });
  return {
    action: input.action,
    status: queuedIntent?.status ?? (input.action === "move" ? "blocked" : "ok"),
    changed: false,
    queued: queuedIntent?.status === "pending" || queuedIntent?.status === "processing",
    intent: queuedIntent ?? null,
    moves,
    models,
    computer: bot.computer
      ? {
          id: bot.computer.id,
          kind: bot.computer.kind,
          state: bot.computer.state,
          machineId: bot.computer.machineId,
        }
      : null,
    pairedMachines: machines.map(({ id, name, lastSeenAt }) => ({
      id,
      name,
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
      status: machineStatusOf({ status: "paired", lastSeenAt }, new Date()),
    })),
    capabilities: {
      pairedComputeRequiresOriginalControlPlane: true,
      automatedRelocation:
        !native &&
        input.action !== "inspect" &&
        input.machineId !== undefined &&
        models.status === "available",
      pairing: "secure_manual_settings",
      nativeRemoteAssignment: false,
      nativeAutomaticExport: false,
      independentServerManualScript: "infra/compose/deploy-server.sh",
    },
    nextStep:
      native && input.action === "move"
        ? "Native cutover is unsupported. An independent deployment can use native Pi/Fabric host tools with a separately reviewed script; do not automatically export credentials or native state."
        : queuedIntent
          ? "Inspect the intent after this run ends. Queued means pending, not moved; active work is preserved."
          : (models.error ??
            "Pairing requires the existing secure manual settings flow. Managed moves require explicit approval; autonomous control-plane migration is unsupported."),
  };
}
