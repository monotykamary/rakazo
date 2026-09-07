import { ORPCError } from "@orpc/server";
import {
  type Actor,
  isModelHidden,
  type ModelCatalogEntry,
  type ModelVisibility,
} from "@rakazo/contracts";
import {
  getModelVisibility,
  IsolationError,
  type PrismaClient,
  setModelVisibility,
} from "@rakazo/db";

export async function getOwnerModelVisibility(
  prisma: PrismaClient,
  actor: Actor,
): Promise<ModelVisibility> {
  try {
    return await getModelVisibility(prisma, actor);
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
}

export async function setOwnerModelVisibility(
  prisma: PrismaClient,
  actor: Actor,
  input: ModelVisibility,
): Promise<ModelVisibility> {
  try {
    return await setModelVisibility(prisma, actor, input);
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
}

export async function visibleModelCatalog(
  prisma: PrismaClient,
  actor: Actor,
  catalog: readonly ModelCatalogEntry[],
): Promise<ModelCatalogEntry[]> {
  const visibility = await getOwnerModelVisibility(prisma, actor);
  return catalog.filter((model) => !isModelHidden(visibility, model.provider, model.id));
}
