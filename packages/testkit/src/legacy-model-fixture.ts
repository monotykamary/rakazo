import { buildModelConnectPlaintext, EncryptedSecretStore } from "@rakazo/adapters";
import type { ModelConnectInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export const LEGACY_MODEL_FIXTURE_KEY = "offline-legacy-model-fixture-encryption-key";

// Persist upgrade-era data without reviving the retired public model manager.
export async function seedLegacyModelCredential(
  prisma: PrismaClient,
  actor: { userId: string; spaceId: string },
  input: ModelConnectInput,
  encryptionKey = LEGACY_MODEL_FIXTURE_KEY,
) {
  const secret = await new EncryptedSecretStore(encryptionKey).put(
    buildModelConnectPlaintext(input),
    { ...actor, operationId: "fixture", traceId: "fixture", signal: new AbortController().signal },
  );
  return prisma.$transaction(async (tx) => {
    await tx.secret.create({
      data: { ...secret, userId: actor.userId, spaceId: null, kind: "model" },
    });
    const credential = await tx.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: input.provider,
        label: input.label ?? "Legacy fixture",
        secretId: secret.id,
      },
    });
    await tx.spaceModelPreference.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        credentialId: credential.id,
        modelId: input.modelId ?? null,
        isDefault: true,
      },
    });
    return credential;
  });
}
