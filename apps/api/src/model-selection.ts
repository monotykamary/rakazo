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

async function authorizedState(prisma: PrismaClient, actor: Actor, input: Scope) {
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

export async function getModelSelection(
  prisma: PrismaClient,
  actor: Actor,
  input: Scope,
  deployment: { provider: string; model: string } | null = null,
): Promise<ModelSelectionStatus> {
  const state = await authorizedState(prisma, actor, input);
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
  if (saved.success && sameModelSelection(saved.data.requested, requested)) return saved.data;
  return {
    requested,
    effective: saved.success ? saved.data.effective : null,
    status: "pending",
    error: null,
  };
}

export async function setWorkerModelSelection(
  prisma: PrismaClient,
  actor: Actor,
  input: Scope & { selection: ModelSelection | null },
  validate: (selection: ModelSelection) => Promise<void>,
  deployment: { provider: string; model: string } | null = null,
): Promise<ModelSelectionStatus> {
  const selection = ModelSelectionSchema.nullable().parse(input.selection);
  await authorizedState(prisma, actor, input);
  if (selection) {
    try {
      await assertModelVisibleForOwner(prisma, actor, selection.provider, selection.modelId);
    } catch (error) {
      if (!(error instanceof ModelHiddenError)) throw error;
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    }
    await validate(selection);
  }
  if (!input.participantId) {
    const changed = await prisma.bot.updateMany({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      data: {
        modelProvider: selection?.provider ?? null,
        modelId: selection?.modelId ?? null,
        thinkingLevel: selection?.thinkingLevel ?? null,
      },
    });
    if (changed.count !== 1) throw new ORPCError("NOT_FOUND");
    return getModelSelection(prisma, actor, input, deployment);
  }
  if (selection === null) {
    await prisma.runtimeModelPreference.deleteMany({
      where: {
        spaceId: actor.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        participantId: input.participantId,
      },
    });
    return getModelSelection(prisma, actor, input, deployment);
  }
  // Intent is separate from opaque fenced checkpoint state: an active worker may save
  // concurrently, but cannot overwrite this stable participant binding.
  await prisma.runtimeModelPreference.upsert({
    where: {
      spaceId_threadId_botId_participantId: {
        spaceId: actor.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        participantId: input.participantId,
      },
    },
    create: {
      spaceId: actor.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      participantId: input.participantId,
      selection: selection as Prisma.InputJsonValue,
    },
    update: { selection: selection as Prisma.InputJsonValue },
  });
  return getModelSelection(prisma, actor, input, deployment);
}
