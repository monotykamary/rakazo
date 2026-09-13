import { ORPCError } from "@orpc/server";
import { type Actor, parseVisionModelRef, type VisionHandoff } from "@rakazo/contracts";
import { getVisionHandoff, IsolationError, type PrismaClient, setVisionHandoff } from "@rakazo/db";

export async function getOwnerVisionHandoff(
  prisma: PrismaClient,
  actor: Actor,
): Promise<VisionHandoff> {
  try {
    return await getVisionHandoff(prisma, actor);
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
}

export async function setOwnerVisionHandoff(
  prisma: PrismaClient,
  actor: Actor,
  input: VisionHandoff,
  acceptsImages: (provider: string, modelId: string) => boolean,
): Promise<VisionHandoff> {
  const parsed = input.visionModel ? parseVisionModelRef(input.visionModel) : null;
  if (input.enabled && !parsed) throw new ORPCError("BAD_REQUEST");
  if (parsed && !acceptsImages(parsed.provider, parsed.id)) throw new ORPCError("BAD_REQUEST");
  try {
    return await setVisionHandoff(prisma, actor, input);
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
}
