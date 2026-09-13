import {
  type Actor,
  DEFAULT_VISION_HANDOFF,
  type VisionHandoff,
  VisionHandoffSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

/** User preferences span their spaces, but never another owner's models. */
export async function getVisionHandoff(
  prisma: Pick<PrismaClient, "user">,
  owner: Pick<Actor, "userId">,
): Promise<VisionHandoff> {
  const user = await prisma.user.findUnique({
    where: { id: owner.userId },
    select: { visionHandoff: true },
  });
  if (!user) throw new IsolationError();
  if (user.visionHandoff == null) return { ...DEFAULT_VISION_HANDOFF };
  return VisionHandoffSchema.parse(user.visionHandoff);
}

export async function setVisionHandoff(
  prisma: Pick<PrismaClient, "user">,
  owner: Pick<Actor, "userId">,
  input: VisionHandoff,
): Promise<VisionHandoff> {
  const visionHandoff = VisionHandoffSchema.parse(input);
  const updated = await prisma.user.updateMany({
    where: { id: owner.userId },
    data: { visionHandoff },
  });
  if (updated.count !== 1) throw new IsolationError();
  return visionHandoff;
}
