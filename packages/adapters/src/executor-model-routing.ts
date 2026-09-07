import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { ModelRoutingSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

type Credential = { id: string; userId: string; secretId: string; provider: string };
export async function resolveExecutorModelRouting(input: {
  prisma: PrismaClient;
  userId: string;
  spaceId: string;
  credential?: { id: string; provider: string };
  provider: string;
  modelId: string;
  explicitOverride: boolean;
  thinkingLevel?: AgentRunRequest["model"]["thinkingLevel"];
  resolve(credential: Credential): Promise<Partial<AgentRunRequest["model"]>>;
  acceptsImages(provider: string, model: string): boolean;
}): Promise<AgentRunRequest["modelRouting"]> {
  if (!input.credential || input.explicitOverride) return undefined;
  const preference = await input.prisma.spaceModelPreference.findFirst({
    where: { spaceId: input.spaceId, userId: input.userId, credentialId: input.credential.id },
  });
  if (!preference?.routing) return undefined;
  const routing = ModelRoutingSchema.parse(preference.routing);
  if (routing.modelId !== input.modelId || input.credential.provider !== input.provider)
    return undefined;
  if (!routing.credentialIds.includes(input.credential.id))
    throw new Error("Selected connection is missing from its routing pool");
  const ids = [
    ...new Set([...routing.credentialIds, ...routing.fallbacks.map((item) => item.credentialId)]),
  ];
  const rows = await input.prisma.userModelCredential.findMany({
    where: { userId: input.userId, id: { in: ids } },
  });
  const credentials = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = credentials.get(id);
    if (!row || row.userId !== input.userId)
      throw new Error("Routing connection authority changed");
    if (routing.credentialIds.includes(id) && row.provider !== input.provider)
      throw new Error("Routing pool provider changed");
    if (
      !(await input.prisma.secret.findFirst({
        where: { id: row.secretId, userId: input.userId, spaceId: null },
        select: { id: true },
      }))
    )
      throw new Error("Routing connection secret unavailable");
  }
  const auth = new Map<string, Partial<AgentRunRequest["model"]>>();
  const candidate = async (credentialId: string, modelId: string) => {
    const row = credentials.get(credentialId)!;
    if (!auth.has(credentialId)) auth.set(credentialId, await input.resolve(row));
    return {
      credentialId,
      model: {
        ...auth.get(credentialId),
        provider: row.provider,
        id: modelId,
        thinkingLevel: input.thinkingLevel,
        acceptsImages: input.acceptsImages(row.provider, modelId),
      },
    };
  };
  const pool = [];
  for (const id of routing.credentialIds) pool.push(await candidate(id, routing.modelId));
  const fallbacks = [];
  for (const item of routing.fallbacks)
    fallbacks.push(await candidate(item.credentialId, item.modelId));
  return {
    key: JSON.stringify([input.userId, input.spaceId, preference.id]),
    strategy: routing.strategy,
    pool,
    fallbacks,
  };
}
