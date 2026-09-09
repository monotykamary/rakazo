import { ORPCError } from "@orpc/server";
import type { PiModelRuntimeService } from "@rakazo/adapters";
import type {
  Actor,
  ModelRuntimeScope,
  ModelRuntimeSnapshot,
  ModelSelectionStatus,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getAuthorizedModelState, getPiModelSelection } from "./model-selection.js";

type ResolvedScope = { botId: string; threadId: string; participantId?: string };

async function resolveScope(
  prisma: PrismaClient,
  actor: Actor,
  input: ModelRuntimeScope,
): Promise<ResolvedScope | null> {
  if (!("botId" in input)) return null;
  if ("threadId" in input && typeof input.threadId === "string") {
    return {
      botId: input.botId,
      threadId: input.threadId,
      ...(input.participantId ? { participantId: input.participantId } : {}),
    };
  }
  const bot = await prisma.bot.findFirst({
    where: {
      id: input.botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
    },
    select: { thread: { select: { id: true } } },
  });
  if (!bot?.thread) throw new ORPCError("NOT_FOUND");
  return { botId: input.botId, threadId: bot.thread.id };
}

function unavailable(
  current: ModelSelectionStatus["effective"],
  selection: ModelSelectionStatus | null,
): ModelRuntimeSnapshot {
  return {
    catalog: [],
    profileDefault: null,
    current,
    selection,
    availability: { status: "unavailable", error: "Pi model runtime is unavailable" },
  };
}

export async function readPiModelRuntime(input: {
  prisma: PrismaClient;
  actor: Actor;
  scope: ModelRuntimeScope;
  models?: PiModelRuntimeService;
  signal?: AbortSignal;
}): Promise<ModelRuntimeSnapshot> {
  const scope = await resolveScope(input.prisma, input.actor, input.scope);
  const checkpoint = scope ? await getAuthorizedModelState(input.prisma, input.actor, scope) : null;
  const selection = scope ? await getPiModelSelection(input.prisma, input.actor, scope) : null;
  const current = selection?.effective ?? null;
  if (!input.models) return unavailable(current, selection);
  if (scope && input.models.supportsCheckpoint?.(checkpoint) !== true) {
    return unavailable(current, selection);
  }
  try {
    const profile = await input.models.read(input.signal);
    return {
      ...profile,
      current,
      selection,
      availability: { status: "available", error: null },
    };
  } catch {
    return unavailable(current, selection);
  }
}
