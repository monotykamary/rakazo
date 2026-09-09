import {
  type Actor,
  type ModelSelection,
  ModelSelectionSchema,
  ModelSelectionStatusSchema,
  sameModelSelection,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { machineStatusOf } from "./machine-tunnel.js";
import { restoreAgentSnapshot } from "./pi-agent-snapshot.js";
import type { PiModelRuntimeService } from "./pi-model-runtime.js";
import { record } from "./pi-rpc-protocol.js";

/** Only deployment composition may resolve a machine's own Pi process/profile authority. */
export type OfficeModelRuntimeResolver = (
  machineId: string | null,
  actor: Pick<Actor, "spaceId" | "userId">,
) => Promise<PiModelRuntimeService | null>;

export interface OfficeModelDeps {
  prisma: PrismaClient;
  resolveOfficeModelRuntime?: OfficeModelRuntimeResolver;
}

/** Local profile access never falls through from a remote office or another owner. */
export function createLocalOfficeModelResolver(
  prisma: PrismaClient,
  models?: PiModelRuntimeService,
): OfficeModelRuntimeResolver {
  return async (machineId, actor) => {
    if (machineId !== null || !models) return null;
    const deployment = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    return deployment?.ownerUserId === actor.userId ? models : null;
  };
}

export type OfficeModelPreflight = {
  authority: "pi";
  status: "available" | "unavailable";
  required: Array<{ kind: "current" | "requested" | "profileDefault"; selection: ModelSelection }>;
  error: string | null;
};

/** Read-only and deliberately independent of the workspace/broker. Never expose probe errors. */
export async function inspectOfficeModels(
  deps: OfficeModelDeps,
  actor: Pick<Actor, "spaceId" | "userId">,
  botId: string,
  machineId?: string | null,
): Promise<OfficeModelPreflight> {
  const required: OfficeModelPreflight["required"] = [];
  const unavailable = (error: string): OfficeModelPreflight => ({
    authority: "pi",
    status: "unavailable",
    required,
    error,
  });
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    select: {
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
      computer: { select: { machineId: true } },
    },
  });
  if (!bot) throw new Error("Office access unavailable");
  // Authorize the destination before any source or destination host probe.
  if (machineId != null) {
    const target = await deps.prisma.machine.findFirst({
      where: { id: machineId, spaceId: actor.spaceId, userId: actor.userId, status: "paired" },
      select: { lastSeenAt: true, status: true },
    });
    if (!target) throw new Error("Target unavailable; inspect paired machines first");
    if (
      machineStatusOf({ status: "paired", lastSeenAt: target.lastSeenAt }, new Date()) !== "online"
    )
      return unavailable("Destination Pi is unavailable");
  }
  const add = (kind: OfficeModelPreflight["required"][number]["kind"], value: unknown) => {
    const selection = ModelSelectionSchema.parse(value);
    if (
      !required.some((item) => item.kind === kind && sameModelSelection(item.selection, selection))
    )
      required.push({ kind, selection });
  };
  try {
    const sessions = await deps.prisma.runtimeSession.findMany({
      where: { spaceId: actor.spaceId, botId },
      select: { state: true },
    });
    const checkpoint = (value: unknown) => {
      const state = record(value);
      const status = ModelSelectionStatusSchema.safeParse(state.modelSelection);
      if (!status.success || !status.data.effective) throw new Error("unknown identity");
      add("current", status.data.effective);
      if (status.data.requested) add("requested", status.data.requested);
    };
    for (const session of sessions) {
      const state = record(session.state);
      checkpoint(state);
      const agents = restoreAgentSnapshot(state, "root");
      for (const entry of agents?.records ?? [])
        checkpoint(record(entry.record.checkpoint).session);
    }
    if (bot.modelProvider || bot.modelId || bot.thinkingLevel)
      add("requested", {
        provider: bot.modelProvider,
        modelId: bot.modelId,
        thinkingLevel: bot.thinkingLevel ?? null,
      });
    const preferences = await deps.prisma.runtimeModelPreference.findMany({
      where: { spaceId: actor.spaceId, botId },
      select: { selection: true },
    });
    for (const preference of preferences) add("requested", preference.selection);
  } catch {
    return unavailable("Current or requested Pi model identity is unknown");
  }
  if (!deps.resolveOfficeModelRuntime) return unavailable("Pi model authority is unavailable");
  try {
    const source = await deps.resolveOfficeModelRuntime(bot.computer?.machineId ?? null, actor);
    if (!source) return unavailable("Source Pi model authority is unavailable");
    const sourceProfile = await source.read();
    if (!sourceProfile.profileDefault) return unavailable("Pi startup default is unknown");
    add("profileDefault", sourceProfile.profileDefault);
    if (machineId === undefined)
      return { authority: "pi", status: "available", required, error: null };
    const target = await deps.resolveOfficeModelRuntime(machineId, actor);
    if (!target) return unavailable("Destination Pi model authority is unavailable");
    const targetProfile = await target.read();
    if (!sameModelSelection(sourceProfile.profileDefault, targetProfile.profileDefault))
      return unavailable("Destination Pi startup default differs; source unchanged");
    for (const { selection } of required) await target.validate(selection);
    return { authority: "pi", status: "available", required, error: null };
  } catch {
    return unavailable("Required Pi model or thinking level is unavailable");
  }
}
