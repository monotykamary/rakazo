import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { resolveExecutorModelRouting } from "./executor-model-routing.js";

function fixture() {
  const credentials = [
    { id: "connection-one", userId: "user", secretId: "secret-one", provider: "openai-compatible" },
    { id: "connection-two", userId: "user", secretId: "secret-two", provider: "openai-compatible" },
  ];
  const prisma = {
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        id: "preference",
        routing: {
          version: 1,
          strategy: "round-robin",
          credentialIds: credentials.map((row) => row.id),
          modelId: "model",
          fallbacks: [{ credentialId: "connection-two", modelId: "backup" }],
        },
      })),
    },
    userModelCredential: { findMany: vi.fn(async () => credentials) },
    secret: { findFirst: vi.fn(async () => ({ id: "secret" })) },
  };
  const resolve = vi.fn(async (row: (typeof credentials)[number]) => ({
    apiKey: `fake-${row.id}`,
  }));
  return {
    prisma,
    credentials,
    resolve,
    input: {
      prisma: prisma as unknown as PrismaClient,
      userId: "user",
      spaceId: "space",
      credential: credentials[0]!,
      provider: "openai-compatible",
      modelId: "model",
      explicitOverride: false,
      resolve,
      acceptsImages: () => true,
    },
  };
}
describe("executor routing authority", () => {
  it("resolves each owned connection once, preserves model fallback and scopes routing identity", async () => {
    const f = fixture();
    const routing = await resolveExecutorModelRouting(f.input);
    expect(routing?.key).toBe(JSON.stringify(["user", "space", "preference"]));
    expect(routing?.pool).toHaveLength(2);
    expect(routing?.fallbacks[0]?.model).toMatchObject({
      id: "backup",
      apiKey: "fake-connection-two",
    });
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.prisma.userModelCredential.findMany).toHaveBeenCalledWith({
      where: { userId: "user", id: { in: ["connection-one", "connection-two"] } },
    });
  });
  it("does not override explicit bot choices", async () => {
    const f = fixture();
    expect(
      await resolveExecutorModelRouting({ ...f.input, explicitOverride: true }),
    ).toBeUndefined();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
  });
  it.each(["owner", "provider", "deleted"])(
    "fails closed when connection %s changes",
    async (change) => {
      const f = fixture();
      if (change === "owner") f.credentials[1]!.userId = "other";
      else if (change === "provider") f.credentials[1]!.provider = "other";
      else f.credentials.pop();
      await expect(resolveExecutorModelRouting(f.input)).rejects.toThrow();
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );
  it("fails before decrypting when a credential secret is no longer available", async () => {
    const f = fixture();
    f.prisma.secret.findFirst.mockResolvedValue(null as never);
    await expect(resolveExecutorModelRouting(f.input)).rejects.toThrow("secret unavailable");
    expect(f.resolve).not.toHaveBeenCalled();
  });
});
