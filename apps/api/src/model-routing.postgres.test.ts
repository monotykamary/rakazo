import { randomUUID } from "node:crypto";
import type { Actor, ModelRouting } from "@rakazo/contracts";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getModelRouting, setModelRouting } from "./model-routing.js";

const describeDatabase =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
describeDatabase("routing settings (PostgreSQL)", () => {
  const id = `routing-${randomUUID()}`;
  const actor: Actor = {
    userId: `${id}-user`,
    spaceId: `${id}-space`,
    email: `${id}@example.test`,
    isDeploymentOwner: false,
  };
  const primary = `${id}-primary`;
  const secondary = `${id}-secondary`;
  const foreign = `${id}-foreign`;
  const catalog = [{ provider: "test-provider", id: "model-a" }];
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.createMany({
      data: [
        { id: actor.userId, name: "Routing Test", email: actor.email, emailVerified: false },
        {
          id: `${id}-other`,
          name: "Other Test",
          email: `${id}-other@example.test`,
          emailVerified: false,
        },
      ],
    });
    await prisma.organization.create({
      data: { id, name: "Routing Test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: actor.spaceId, organizationId: id, name: "Routing Test", isDefault: true },
    });
    await prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: id,
        userId: actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await prisma.userModelCredential.createMany({
      data: [primary, secondary]
        .map((credentialId) => ({
          id: credentialId,
          userId: actor.userId,
          provider: "test-provider",
          label: "Test Connection",
          secretId: `${credentialId}-secret`,
        }))
        .concat([
          {
            id: foreign,
            userId: `${id}-other`,
            provider: "test-provider",
            label: "Other Connection",
            secretId: `${foreign}-secret`,
          },
        ]),
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id: { in: [actor.userId, `${id}-other`] } } });
    await close();
  });
  it("persists a scoped policy without changing default selection or exposing foreign credentials", async () => {
    const policy: ModelRouting = {
      version: 1,
      strategy: "round-robin",
      credentialIds: [primary, secondary],
      modelId: "model-a",
      fallbacks: [],
    };
    expect(
      await setModelRouting(prisma, actor, { credentialId: primary, routing: policy }, catalog),
    ).toEqual(policy);
    expect(await getModelRouting(prisma, actor, primary)).toEqual(policy);
    expect(
      await getModelRouting(prisma, { ...actor, spaceId: `${id}-unrelated` }, primary),
    ).toBeNull();
    expect(
      (await prisma.spaceModelPreference.findFirst({ where: { credentialId: primary } }))
        ?.isDefault,
    ).toBe(false);
    await expect(
      setModelRouting(
        prisma,
        actor,
        { credentialId: primary, routing: { ...policy, credentialIds: [primary, foreign] } },
        catalog,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getModelRouting(prisma, actor, primary)).toEqual(policy);
    await setModelRouting(prisma, actor, { credentialId: primary, routing: null }, catalog);
    expect(await getModelRouting(prisma, actor, primary)).toBeNull();
    expect(await prisma.userModelCredential.count({ where: { userId: actor.userId } })).toBe(2);
  });
});
