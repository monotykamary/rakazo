import { ORPCError } from "@orpc/server";
import {
  type Actor,
  type ModelCatalogEntry,
  type ModelRouting,
  ModelRoutingSchema,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "@rakazo/db";
import { withSerializableRetry } from "./serializable-retry.js";

export async function getModelRouting(
  prisma: PrismaClient,
  actor: Actor,
  credentialId: string,
): Promise<ModelRouting | null> {
  const credential = await prisma.userModelCredential.findFirst({
    where: { id: credentialId, userId: actor.userId },
    select: { id: true },
  });
  if (!credential) throw new ORPCError("NOT_FOUND");
  const preference = await prisma.spaceModelPreference.findUnique({
    where: {
      spaceId_userId_credentialId: { spaceId: actor.spaceId, userId: actor.userId, credentialId },
    },
    select: { routing: true },
  });
  if (preference?.routing == null) return null;
  const parsed = ModelRoutingSchema.safeParse(preference.routing);
  if (!parsed.success)
    throw new ORPCError("CONFLICT", { message: "Model routing needs to be configured again." });
  return parsed.data;
}

export async function setModelRouting(
  prisma: PrismaClient,
  actor: Actor,
  input: { credentialId: string; routing: ModelRouting | null },
  catalog: ReadonlyArray<Pick<ModelCatalogEntry, "provider" | "id" | "placeholder">>,
): Promise<ModelRouting | null> {
  const routing = input.routing === null ? null : ModelRoutingSchema.parse(input.routing);
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const credentialIds = [
          ...new Set([
            input.credentialId,
            ...(routing?.credentialIds ?? []),
            ...(routing?.fallbacks.map((target) => target.credentialId) ?? []),
          ]),
        ];
        const credentials = await tx.userModelCredential.findMany({
          where: { userId: actor.userId, id: { in: credentialIds } },
          select: {
            id: true,
            provider: true,
            preferences: {
              where: { userId: actor.userId, spaceId: actor.spaceId },
              select: { modelId: true },
            },
          },
        });
        if (credentials.length !== credentialIds.length) throw new ORPCError("NOT_FOUND");
        const root = credentials.find((entry) => entry.id === input.credentialId)!;
        const scope = {
          spaceId: actor.spaceId,
          userId: actor.userId,
          credentialId: input.credentialId,
        };
        if (routing === null) {
          await tx.spaceModelPreference.updateMany({
            where: scope,
            data: { routing: Prisma.DbNull },
          });
          return null;
        }
        if (!routing.credentialIds.includes(root.id))
          throw new ORPCError("BAD_REQUEST", {
            message: "The primary connection must be in the pool.",
          });
        const targets = [
          ...routing.credentialIds.map((credentialId) => ({
            credentialId,
            modelId: routing.modelId,
          })),
          ...routing.fallbacks,
        ];
        const identities = new Set<string>();
        for (const target of targets) {
          const credential = credentials.find((entry) => entry.id === target.credentialId)!;
          const identity = JSON.stringify([target.credentialId, target.modelId]);
          if (identities.has(identity))
            throw new ORPCError("BAD_REQUEST", { message: "Duplicate model routing target." });
          identities.add(identity);
          if (
            routing.credentialIds.includes(target.credentialId) &&
            target.modelId === routing.modelId &&
            credential.provider !== root.provider
          ) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Pool connections must use the same provider.",
            });
          }
          const configured =
            credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
              ? credential.preferences.some((preference) => preference.modelId === target.modelId)
              : catalog.some(
                  (model) =>
                    model.provider === credential.provider &&
                    model.id === target.modelId &&
                    !model.placeholder,
                );
          if (!configured)
            throw new ORPCError("BAD_REQUEST", {
              message: "The model is not configured for that connection.",
            });
        }
        await tx.spaceModelPreference.upsert({
          where: { spaceId_userId_credentialId: scope },
          create: { ...scope, modelId: routing.modelId, routing: routing as Prisma.InputJsonValue },
          update: { modelId: routing.modelId, routing: routing as Prisma.InputJsonValue },
        });
        return routing;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
