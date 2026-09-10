import { ORPCError } from "@orpc/server";
import { selectConfiguredModel } from "@rakazo/adapters";
import {
  type Actor,
  ModelHiddenError,
  type ModelSelection,
  ModelSelectionSchema,
  type ModelSelectionStatus,
  ModelSelectionStatusSchema,
  sameModelSelection,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  assertModelVisibleForOwner,
  assertPremoveQueueAccess,
  findDefaultModelCredential,
  findModelCredential,
  IsolationError,
  type Prisma,
  type PrismaClient,
} from "@rakazo/db";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
type Scope = { botId: string; threadId: string; participantId?: string };

async function hasActiveRun(prisma: PrismaClient, actor: Actor, input: Scope) {
  const run = await prisma.run.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: input.botId,
      threadId: input.threadId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  return Boolean(run);
}

function unresolvedSelection(
  requested: ModelSelection | null,
  saved: ModelSelectionStatus | null,
): ModelSelectionStatus {
  return {
    requested,
    effective: saved?.effective ?? null,
    status: "pending",
    error: null,
  };
}

async function resolveSelection(
  prisma: PrismaClient,
  actor: Actor,
  input: Scope,
  requested: ModelSelection | null,
  saved: ModelSelectionStatus | null,
): Promise<ModelSelectionStatus> {
  if (saved && sameModelSelection(saved.requested, requested)) return saved;
  if (!(await hasActiveRun(prisma, actor, input))) {
    return {
      requested,
      effective: requested ?? saved?.effective ?? null,
      status: "applied",
      error: null,
    };
  }
  return unresolvedSelection(requested, saved);
}

export async function getAuthorizedModelState(prisma: PrismaClient, actor: Actor, input: Scope) {
  try {
    await assertPremoveQueueAccess(prisma, actor, { ...input, spaceId: actor.spaceId });
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
  const row = await prisma.runtimeSession.findUnique({
    where: {
      spaceId_threadId_botId: {
        spaceId: actor.spaceId,
        threadId: input.threadId,
        botId: input.botId,
      },
    },
    select: { state: true },
  });
  const root = object(row?.state);
  if (!input.participantId) return root;
  const participant = object(object(root.participants)[input.participantId]);
  if (participant.participantId !== input.participantId) throw new ORPCError("NOT_FOUND");
  return object(participant.session);
}

export async function getPiModelSelection(
  prisma: PrismaClient,
  actor: Actor,
  input: Scope,
): Promise<ModelSelectionStatus> {
  const state = await getAuthorizedModelState(prisma, actor, input);
  const saved = ModelSelectionStatusSchema.safeParse(state.modelSelection);
  const bot = await prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND");
  let requested: ModelSelection | null =
    bot.modelProvider && bot.modelId
      ? {
          provider: bot.modelProvider,
          modelId: bot.modelId,
          thinkingLevel: ModelSelectionSchema.shape.thinkingLevel.safeParse(bot.thinkingLevel)
            .success
            ? (bot.thinkingLevel as ModelSelection["thinkingLevel"])
            : null,
        }
      : null;
  if (input.participantId) {
    const preference = await prisma.runtimeModelPreference.findUnique({
      where: {
        spaceId_threadId_botId_participantId: {
          spaceId: actor.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          participantId: input.participantId,
        },
      },
    });
    const parsed = ModelSelectionSchema.safeParse(preference?.selection);
    if (parsed.success) requested = parsed.data;
  }
  return resolveSelection(prisma, actor, input, requested, saved.success ? saved.data : null);
}

export async function getModelSelection(
  prisma: PrismaClient,
  actor: Actor,
  input: Scope,
  deployment: { provider: string; model: string } | null = null,
): Promise<ModelSelectionStatus> {
  const state = await getAuthorizedModelState(prisma, actor, input);
  const saved = ModelSelectionStatusSchema.safeParse(state.modelSelection);
  let requested: ModelSelection | null;
  const bot = await prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  const [overrideCredential, defaultCredential, settings] = await Promise.all([
    bot?.modelProvider ? findModelCredential(prisma, actor, bot.modelProvider) : null,
    findDefaultModelCredential(prisma, actor),
    prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  const model = selectConfiguredModel({
    bot,
    overrideCredential,
    defaultCredential,
    settings,
    deployment,
  });
  requested =
    model.provider && model.id
      ? { provider: model.provider, modelId: model.id, thinkingLevel: model.thinkingLevel }
      : null;
  if (input.participantId) {
    const preference = await prisma.runtimeModelPreference.findUnique({
      where: {
        spaceId_threadId_botId_participantId: {
          spaceId: actor.spaceId,
          threadId: input.threadId,
          botId: input.botId,
          participantId: input.participantId,
        },
      },
    });
    const parsed = ModelSelectionSchema.safeParse(preference?.selection);
    if (parsed.success) requested = parsed.data;
  }
  if (requested) {
    try {
      await assertModelVisibleForOwner(prisma, actor, requested.provider, requested.modelId);
    } catch (error) {
      if (!(error instanceof ModelHiddenError)) throw error;
      return {
        requested,
        effective: saved.success ? saved.data.effective : null,
        status: "failed",
        error: error.message,
      };
    }
  }
  return resolveSelection(prisma, actor, input, requested, saved.success ? saved.data : null);
}

export async function setWorkerModelSelection(
  prisma: PrismaClient,
  actor: Actor,
  input: Scope & { selection: ModelSelection | null },
  validate: (selection: ModelSelection) => Promise<void>,
  deployment: { provider: string; model: string } | null = null,
  piOwned = false,
): Promise<ModelSelectionStatus> {
  const selection = ModelSelectionSchema.nullable().parse(input.selection);
  const readStatus = () =>
    piOwned
      ? getPiModelSelection(prisma, actor, input)
      : getModelSelection(prisma, actor, input, deployment);
  await getAuthorizedModelState(prisma, actor, input);
  if (selection) {
    if (!piOwned) {
      try {
        await assertModelVisibleForOwner(prisma, actor, selection.provider, selection.modelId);
      } catch (error) {
        if (!(error instanceof ModelHiddenError)) throw error;
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
    }
    await validate(selection);
  }
  if (!input.participantId) {
    const changed = await prisma.bot.updateMany({
      where: {
        id: input.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        archivedAt: null,
        computerSwitching: false,
      },
      data: {
        modelProvider: selection?.provider ?? null,
        modelId: selection?.modelId ?? null,
        thinkingLevel: selection?.thinkingLevel ?? null,
      },
    });
    if (changed.count !== 1) {
      throw new ORPCError("CONFLICT", {
        message: "Model selection cannot change while the bot is moving",
      });
    }
    return readStatus();
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
    const stable = await tx.bot.findFirst({
      where: {
        id: input.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        archivedAt: null,
        computerSwitching: false,
      },
      select: { id: true },
    });
    if (!stable) {
      throw new ORPCError("CONFLICT", {
        message: "Model selection cannot change while the bot is moving",
      });
    }
    const scope = {
      spaceId: actor.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      participantId: input.participantId!,
    };
    if (selection === null) {
      await tx.runtimeModelPreference.deleteMany({ where: scope });
      return;
    }
    await tx.runtimeModelPreference.upsert({
      where: { spaceId_threadId_botId_participantId: scope },
      create: { ...scope, selection: selection as Prisma.InputJsonValue },
      update: { selection: selection as Prisma.InputJsonValue },
    });
  });
  return readStatus();
}
