import {
  type Actor,
  assertModelVisible,
  type ModelVisibility,
  ModelVisibilitySchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

/** User preferences span their spaces, but never another owner's models. */
export async function getModelVisibility(
  prisma: Pick<PrismaClient, "user">,
  owner: Pick<Actor, "userId">,
): Promise<ModelVisibility> {
  const user = await prisma.user.findUnique({
    where: { id: owner.userId },
    select: { modelVisibility: true },
  });
  if (!user) throw new IsolationError();
  // Invalid stored preferences must not silently re-enable unwanted models.
  return ModelVisibilitySchema.parse(user.modelVisibility);
}

export async function setModelVisibility(
  prisma: Pick<PrismaClient, "user">,
  owner: Pick<Actor, "userId">,
  input: ModelVisibility,
): Promise<ModelVisibility> {
  const visibility = ModelVisibilitySchema.parse(input);
  const hide = visibility.hide.filter(
    (rule, index, rules) =>
      rules.findIndex((other) => other.provider === rule.provider && other.model === rule.model) ===
      index,
  );
  const updated = await prisma.user.updateMany({
    where: { id: owner.userId },
    data: { modelVisibility: { hide } },
  });
  if (updated.count !== 1) throw new IsolationError();
  return { hide };
}

export async function assertModelVisibleForOwner(
  prisma: Pick<PrismaClient, "user">,
  owner: Pick<Actor, "userId">,
  provider: string,
  modelId: string,
): Promise<void> {
  assertModelVisible(await getModelVisibility(prisma, owner), provider, modelId);
}
