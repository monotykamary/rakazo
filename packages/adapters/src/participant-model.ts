import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { type ModelSelection, ModelSelectionSchema } from "@rakazo/contracts";
import {
  assertModelVisibleForOwner,
  findModelCredential,
  type Prisma,
  type PrismaClient,
} from "@rakazo/db";
import { matchesDeploymentModel } from "./model-selection.js";
import { modelsForRequest, thinkingLevelFor } from "./pi-runtime.js";

export async function resolveParticipantModel(input: {
  prisma: PrismaClient;
  scope: { spaceId: string; userId: string; threadId: string; botId: string };
  participantId: string;
  selection?: ModelSelection;
  deployment?: { provider: string; model: string } | null;
  resolve(
    credential: { secretId: string; provider: string } | null,
    provider: string,
  ): Promise<Partial<AgentRunRequest["model"]>>;
}): Promise<AgentRunRequest["model"] | undefined> {
  const { userId, ...scope } = input.scope;
  const key = { ...scope, participantId: input.participantId };
  const preference = await input.prisma.runtimeModelPreference.findUnique({
    where: { spaceId_threadId_botId_participantId: key },
  });
  const value = input.selection ?? preference?.selection;
  if (!value) return undefined;
  const selected = ModelSelectionSchema.parse(value);
  await assertModelVisibleForOwner(input.prisma, input.scope, selected.provider, selected.modelId);
  const credential = await findModelCredential(input.prisma, input.scope, selected.provider);
  if (credential) {
    if (
      !(await input.prisma.secret.findFirst({
        where: { id: credential.secretId, userId, spaceId: null },
        select: { id: true },
      }))
    )
      throw new Error("Worker model connection unavailable");
  } else if (!matchesDeploymentModel(selected.provider, selected.modelId, input.deployment)) {
    throw new Error("Worker model connection unavailable");
  }
  const auth = await input.resolve(credential, selected.provider);
  const model = {
    ...auth,
    provider: selected.provider,
    id: selected.modelId,
    thinkingLevel: selected.thinkingLevel,
  };
  const resolved = modelsForRequest({ model }, model.provider).getModel(model.provider, model.id);
  if (
    !resolved ||
    (selected.thinkingLevel !== null &&
      thinkingLevelFor(resolved, selected.thinkingLevel) !== selected.thinkingLevel)
  )
    throw new Error("Worker model or reasoning level is unavailable");
  if (input.selection)
    await input.prisma.runtimeModelPreference.upsert({
      where: { spaceId_threadId_botId_participantId: key },
      create: { ...key, selection: selected as Prisma.InputJsonValue },
      update: { selection: selected as Prisma.InputJsonValue },
    });
  return { ...model, acceptsImages: resolved.input.includes("image") };
}
