import { createRouterClient } from "@orpc/server";
import type { Actor, ModelRouting } from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { getModelRouting, setModelRouting } from "./model-routing.js";
import { createRouter, type RouterDeps } from "./router.js";

const actor = { userId: "owner", spaceId: "space" } as Actor;
const routing: ModelRouting = {
  version: 1,
  strategy: "round-robin",
  credentialIds: ["primary", "secondary"],
  modelId: "model-a",
  fallbacks: [{ credentialId: "fallback", modelId: "model-b" }],
};
const catalog = [
  { provider: "provider-a", id: "model-a" },
  { provider: "provider-b", id: "model-b" },
];
function fixture() {
  const credentials = [
    { id: "primary", provider: "provider-a", preferences: [] },
    { id: "secondary", provider: "provider-a", preferences: [] },
    { id: "fallback", provider: "provider-b", preferences: [] },
  ];
  const tx = {
    userModelCredential: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        credentials.filter((row) => args.where.id.in.includes(row.id)),
      ),
      findFirst: vi.fn(async () => ({ id: "primary" })),
    },
    spaceModelPreference: {
      findUnique: vi.fn(async () => ({ routing })),
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  const prisma = { ...tx, $transaction: transaction } as unknown as PrismaClient;
  return { prisma, tx, transaction, credentials };
}

describe("model routing settings", () => {
  it("registers authenticated methods without touching storage for anonymous callers", async () => {
    const { prisma, tx } = fixture();
    const client = createRouterClient(
      createRouter({
        prisma,
        secrets: {},
        sandbox: {},
        home: {},
        events: {},
        jobs: {},
      } as unknown as RouterDeps),
      { context: { actor: null } },
    );
    await expect(client.models.getRouting({ credentialId: "primary" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      client.models.setRouting({ credentialId: "primary", routing }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.userModelCredential.findMany).not.toHaveBeenCalled();
    expect(tx.userModelCredential.findFirst).not.toHaveBeenCalled();
  });
  it("stores an owned same-provider pool and explicit different-model fallback", async () => {
    const { prisma, tx, transaction } = fixture();
    expect(
      await setModelRouting(prisma, actor, { credentialId: "primary", routing }, catalog),
    ).toEqual(routing);
    expect(tx.userModelCredential.findMany.mock.calls[0]?.[0].where).toMatchObject({
      userId: actor.userId,
    });
    expect(tx.spaceModelPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            credentialId: "primary",
          },
        },
        update: { modelId: "model-a", routing },
      }),
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });
  it("reads only the actor's scoped preference", async () => {
    const { prisma, tx } = fixture();
    expect(await getModelRouting(prisma, actor, "primary")).toEqual(routing);
    expect(tx.userModelCredential.findFirst).toHaveBeenCalledWith({
      where: { id: "primary", userId: actor.userId },
      select: { id: true },
    });
    expect(tx.spaceModelPreference.findUnique).toHaveBeenCalledWith({
      where: {
        spaceId_userId_credentialId: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          credentialId: "primary",
        },
      },
      select: { routing: true },
    });
  });
  it("rejects missing or foreign fallback credentials without saving", async () => {
    const { prisma, tx, credentials } = fixture();
    credentials.pop();
    await expect(
      setModelRouting(prisma, actor, { credentialId: "primary", routing }, catalog),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx.spaceModelPreference.upsert).not.toHaveBeenCalled();
  });
  it.each([
    { ...routing, credentialIds: ["secondary"] },
    { ...routing, credentialIds: ["primary", "fallback"], fallbacks: [] },
    { ...routing, modelId: "unknown" },
    { ...routing, fallbacks: [{ credentialId: "primary", modelId: "model-a" }] },
  ])("rejects unauthorized pool/model semantics %#", async (invalid) => {
    const { prisma, tx } = fixture();
    await expect(
      setModelRouting(prisma, actor, { credentialId: "primary", routing: invalid }, catalog),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(tx.spaceModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("removes routing only from the current space without selecting another default", async () => {
    const { prisma, tx } = fixture();
    expect(
      await setModelRouting(prisma, actor, { credentialId: "primary", routing: null }, catalog),
    ).toBeNull();
    expect(tx.spaceModelPreference.updateMany).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId, userId: actor.userId, credentialId: "primary" },
      data: { routing: Prisma.DbNull },
    });
    expect(tx.spaceModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("requires a custom endpoint model to match its explicitly configured connection", async () => {
    const { prisma, tx } = fixture();
    tx.userModelCredential.findMany.mockResolvedValue([
      { id: "primary", provider: "openai-compatible", preferences: [{ modelId: "custom-model" }] },
    ] as never);
    const custom: ModelRouting = {
      ...routing,
      credentialIds: ["primary"],
      modelId: "custom-model",
      fallbacks: [],
    };
    expect(
      await setModelRouting(prisma, actor, { credentialId: "primary", routing: custom }, []),
    ).toEqual(custom);
    await expect(
      setModelRouting(
        prisma,
        actor,
        { credentialId: "primary", routing: { ...custom, modelId: "unconfigured" } },
        [],
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
