import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

afterEach(() => vi.unstubAllEnvs());

function fixture(deploymentModelKey?: string) {
  const scope = { userId: "owner", spaceId: "space", botId: "bot" };
  const bot = { modelProvider: "openai-compatible", modelId: "bot-model", thinkingLevel: "high" };
  const pin = {
    id: "pin",
    provider: bot.modelProvider,
    secretId: "pin-secret",
    userId: scope.userId,
  };
  const fallback = {
    id: "default",
    provider: "other-provider",
    secretId: "other-secret",
    userId: scope.userId,
  };
  let connected = true;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        modelVisibility: { hide: [] as Array<{ provider: string; model?: string }> },
      })),
    },
    bot: { findFirst: vi.fn(async () => bot) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    spaceModelPreference: {
      findFirst: vi.fn(async (args: any) =>
        args.where.isDefault
          ? { credential: fallback, modelId: "default-model", isDefault: true }
          : connected
            ? { credential: pin, modelId: "credential-default", isDefault: false }
            : null,
      ),
    },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => ({ id: pin.secretId, ciphertext: "fake-encrypted" })) },
  };
  const secretStore = {
    load: vi.fn(() =>
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://offline.invalid/v1",
        apiKey: "fake-key",
        reasoning: true,
      }),
    ),
  };
  const executor = createRunExecutor({
    runtime: {
      describe: () => ({
        id: "pi",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { streaming: true, compaction: true, tools: true },
      }),
    },
    prisma,
    secretStore,
    deploymentModelKey,
    web: {},
    browser: {},
    sandbox: {},
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    scope,
    bot,
    prisma,
    secretStore,
    executor,
    revoke: () => {
      connected = false;
    },
  };
}

describe("executor model authority", () => {
  it("allows an exact deployment-default pin without a user credential row", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "deployment-provider");
    vi.stubEnv("PI_DEFAULT_MODEL", "deployment-model");
    const f = fixture("fake-deployment-key");
    f.revoke();
    f.bot.modelProvider = "deployment-provider";
    f.bot.modelId = "deployment-model";
    expect(await f.executor.resolveModel(f.scope)).toMatchObject({
      provider: "deployment-provider",
      id: "deployment-model",
      thinkingLevel: "high",
      apiKey: "fake-deployment-key",
    });
    expect(f.prisma.secret.findFirst).not.toHaveBeenCalled();
    f.bot.modelId = "other-model";
    await expect(f.executor.resolveModel(f.scope)).rejects.toThrow("Model connection unavailable");
    f.bot.modelId = "deployment-model";
    f.prisma.user.findUnique.mockResolvedValueOnce({
      modelVisibility: { hide: [{ provider: "deployment-provider" }] },
    });
    await expect(f.executor.resolveModel(f.scope)).rejects.toThrow("hidden");
  });

  it("resolves each bot's exact model and independent reasoning with its own credential", async () => {
    const f = fixture();
    expect(await f.executor.resolveModel(f.scope)).toMatchObject({
      provider: f.bot.modelProvider,
      id: "bot-model",
      thinkingLevel: "high",
      apiKey: "fake-key",
    });
    expect(f.prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "pin-secret", userId: "owner", spaceId: null },
    });
    expect(f.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "owner" },
      select: { modelVisibility: true },
    });
  });
  it("does not replace a revoked pin with the Space default", async () => {
    const f = fixture();
    f.revoke();
    await expect(f.executor.resolveModel(f.scope)).rejects.toThrow("Model connection unavailable");
    expect(f.prisma.secret.findFirst).not.toHaveBeenCalled();
  });
  it("does not substitute deployment credentials for a revoked owned secret", async () => {
    const f = fixture();
    f.prisma.secret.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.executor.resolveModel(f.scope)).rejects.toThrow("Model connection unavailable");
    expect(f.secretStore.load).not.toHaveBeenCalled();
  });
  it("preserves a hidden pin and fails before decrypting any credential", async () => {
    const f = fixture();
    f.prisma.user.findUnique.mockResolvedValueOnce({
      modelVisibility: { hide: [{ provider: f.bot.modelProvider, model: f.bot.modelId }] },
    });
    await expect(f.executor.resolveModel(f.scope)).rejects.toThrow("hidden");
    expect(f.prisma.secret.findFirst).not.toHaveBeenCalled();
    expect(f.bot).toMatchObject({ modelId: "bot-model", thinkingLevel: "high" });
  });
});
