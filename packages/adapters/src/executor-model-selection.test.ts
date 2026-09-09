import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor, resolvePiModelIntent } from "./executor.js";

afterEach(() => vi.unstubAllEnvs());

function fixture(deploymentModelKey?: string, runtimeId = "pi") {
  const scope = { userId: "owner", spaceId: "space", botId: "bot" };
  const bot = {
    modelProvider: "openai-compatible" as string | null,
    modelId: "bot-model" as string | null,
    thinkingLevel: "high" as string | null,
    temporary: false,
    computer: null,
  };
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
    deploymentSettings: {
      findUnique: vi.fn(async (args?: any) =>
        args?.select?.ownerUserId ? { ownerUserId: scope.userId } : null,
      ),
    },
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
        id: runtimeId,
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
    sandbox: { describe: () => ({ id: "desktop", capabilities: {} }) },
    localPiCwd: "/tmp",
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
  it("resolves participant Pi intent before bot intent without credentials", () => {
    const bot = { modelProvider: "bot-provider", modelId: "bot-model", thinkingLevel: "low" };
    expect(
      resolvePiModelIntent(bot, {
        provider: "worker-provider",
        modelId: "worker-model",
        thinkingLevel: "high",
      }),
    ).toEqual({
      provider: "worker-provider",
      id: "worker-model",
      thinkingLevel: "high",
      apiKey: "",
    });
    expect(resolvePiModelIntent(bot, null)).toMatchObject({
      provider: "bot-provider",
      id: "bot-model",
      thinkingLevel: "low",
    });
    expect(resolvePiModelIntent({}, { invalid: true })).toMatchObject({
      provider: "pi-local",
      id: "default",
      apiKey: "",
    });
  });
  it("delegates native model authority to Pi without reading Rakazo credentials", async () => {
    const f = fixture(undefined, "pi-local");

    await expect(f.executor.resolveModel(f.scope)).resolves.toMatchObject({
      provider: "openai-compatible",
      id: "bot-model",
      thinkingLevel: "high",
      apiKey: "",
    });
    expect(f.prisma.spaceModelPreference.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.secret.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.user.findUnique).not.toHaveBeenCalled();

    f.bot.modelProvider = null;
    f.bot.modelId = null;
    f.bot.thinkingLevel = null;
    await expect(f.executor.resolveModel(f.scope)).resolves.toMatchObject({
      provider: "pi-local",
      id: "default",
      apiKey: "",
    });
  });
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
    const { modelProvider, modelId } = f.bot;
    if (modelProvider === null || modelId === null)
      throw new Error("Expected a pinned fixture model");
    f.prisma.user.findUnique.mockResolvedValueOnce({
      modelVisibility: { hide: [{ provider: modelProvider, model: modelId }] },
    });
    await expect(f.executor.resolveModel(f.scope)).rejects.toThrow("hidden");
    expect(f.prisma.secret.findFirst).not.toHaveBeenCalled();
    expect(f.bot).toMatchObject({ modelId: "bot-model", thinkingLevel: "high" });
  });
});
