import { createRouterClient } from "@orpc/server";
import type { Actor, ModelSelection } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { getModelSelection, setWorkerModelSelection } from "./model-selection.js";
import { createRouter, type RouterDeps } from "./router.js";

const actor = { userId: "owner", spaceId: "space" } as Actor;
const scope = { botId: "bot", threadId: "thread", participantId: "worker" };
const old: ModelSelection = { provider: "openai-compatible", modelId: "old", thinkingLevel: "low" };
const selection: ModelSelection = { ...old, modelId: "new", thinkingLevel: "high" };
function fixture() {
  const current = { requested: old, effective: old, status: "applied", error: null };
  const state = {
    modelSelection: current,
    privateHistory: "not public",
    participants: {
      worker: {
        participantId: "worker",
        status: "running",
        session: { modelSelection: current, privateHistory: "not public" },
      },
    },
  };
  const bot = {
    id: "bot",
    modelProvider: old.provider,
    modelId: old.modelId,
    thinkingLevel: old.thinkingLevel,
  };
  let preference: any;
  const credential = {
    id: "connection",
    userId: actor.userId,
    secretId: "secret",
    provider: old.provider,
    label: "Offline",
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        modelVisibility: { hide: [] as Array<{ provider: string; model?: string }> },
      })),
    },
    thread: { findFirst: vi.fn(async () => ({ id: "thread" })) },
    bot: {
      findFirst: vi.fn(async () => bot),
      updateMany: vi.fn(async (args: any) => {
        Object.assign(bot, args.data);
        return { count: 1 };
      }),
    },
    runtimeSession: { findUnique: vi.fn(async () => ({ state })), update: vi.fn() },
    runtimeModelPreference: {
      findUnique: vi.fn(async () => preference),
      upsert: vi.fn(async (args: any) => {
        preference = args.create;
        return preference;
      }),
      deleteMany: vi.fn(async () => {
        preference = undefined;
        return { count: 1 };
      }),
    },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({ credential, modelId: "old", isDefault: true })),
    },
    userModelCredential: { findFirst: vi.fn(async () => credential) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => ({ ciphertext: "fake-encrypted" })) },
  };
  const prisma = db as unknown as PrismaClient;
  const client = (authenticated = true, env: Record<string, unknown> = {}) =>
    createRouterClient(
      createRouter({
        prisma,
        secrets: {
          load: () =>
            JSON.stringify({
              kind: "openai_compatible",
              apiKey: "fake",
              baseUrl: "http://offline.invalid/v1",
              reasoning: true,
            }),
        },
        env,
        sandbox: {},
        home: {},
        events: {},
        jobs: {},
      } as unknown as RouterDeps),
      { context: { actor: authenticated ? actor : null } },
    );
  return { db, prisma, client, state, bot };
}
describe("model selection routes", () => {
  it("registers both authenticated model methods and rejects anonymous callers before storage", async () => {
    const f = fixture();
    const client = f.client(false);
    await expect(client.models.getSelection(scope)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.models.setWorkerSelection({ ...scope, selection })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(f.db.thread.findFirst).not.toHaveBeenCalled();
  });
  it("returns only public configuration, never opaque transcripts", async () => {
    const f = fixture();
    expect(await f.client().models.getSelection(scope)).toEqual({
      requested: old,
      effective: old,
      status: "applied",
      error: null,
    });
    expect(f.db.thread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: actor.userId, spaceId: actor.spaceId }),
      }),
    );
  });
  it("records busy worker intent separately and preserves effective state/checkpoint", async () => {
    const f = fixture();
    const validate = vi.fn(async () => {});
    const result = await setWorkerModelSelection(
      f.prisma,
      actor,
      { ...scope, selection },
      validate,
    );
    expect(result).toEqual({
      requested: selection,
      effective: old,
      status: "pending",
      error: null,
    });
    expect(f.db.runtimeSession.update).not.toHaveBeenCalled();
    expect(f.state.participants.worker.session.modelSelection.effective).toEqual(old);
    expect(f.db.runtimeModelPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId_threadId_botId_participantId: { ...scope, spaceId: actor.spaceId } },
      }),
    );
  });
  it("writes hidden durable worker bot pins without requiring a visible bot list entry", async () => {
    const f = fixture();
    const result = await setWorkerModelSelection(
      f.prisma,
      actor,
      { botId: "bot", threadId: "thread", selection },
      async () => {},
    );
    expect(result).toMatchObject({ requested: selection, effective: old, status: "pending" });
    expect(f.db.bot.updateMany).toHaveBeenCalledWith({
      where: { id: "bot", spaceId: "space", userId: "owner", archivedAt: null },
      data: {
        modelProvider: selection.provider,
        modelId: selection.modelId,
        thinkingLevel: "high",
      },
    });
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("rejects foreign thread access and fabricated participants before validation or writes", async () => {
    const f = fixture();
    const validate = vi.fn(async () => {});
    await expect(
      setWorkerModelSelection(
        f.prisma,
        actor,
        { ...scope, participantId: "foreign", selection },
        validate,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    f.db.thread.findFirst.mockResolvedValueOnce(null as never);
    await expect(getModelSelection(f.prisma, actor, scope)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(validate).not.toHaveBeenCalled();
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("leaves requested and effective untouched when model validation fails", async () => {
    const f = fixture();
    await expect(
      setWorkerModelSelection(f.prisma, actor, { ...scope, selection }, async () => {
        throw new Error("Unsupported model");
      }),
    ).rejects.toThrow("Unsupported model");
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("resets a busy worker to the current bot without resurrecting checkpoint intent", async () => {
    const f = fixture();
    await f.client().models.setWorkerSelection({ ...scope, selection });
    f.state.participants.worker.session.modelSelection = {
      requested: selection,
      effective: old,
      status: "failed",
      error: "Retry required",
    };
    f.bot.modelId = "bot-now";
    const reset = await f.client().models.setWorkerSelection({ ...scope, selection: null });
    expect(reset).toEqual({
      requested: { ...old, modelId: "bot-now" },
      effective: old,
      status: "pending",
      error: null,
    });
    expect(f.db.runtimeModelPreference.deleteMany).toHaveBeenCalledWith({
      where: { ...scope, spaceId: actor.spaceId },
    });
    expect(f.db.runtimeSession.update).not.toHaveBeenCalled();
    f.bot.thinkingLevel = "high";
    expect(await f.client().models.getSelection(scope)).toMatchObject({
      requested: { modelId: "bot-now", thinkingLevel: "high" },
      effective: old,
      status: "pending",
    });
  });
  it("reset and same-pin writes remain applied when the worker already uses its bot", async () => {
    const f = fixture();
    const expected = { requested: old, effective: old, status: "applied", error: null };
    expect(await f.client().models.setWorkerSelection({ ...scope, selection: old })).toEqual(
      expected,
    );
    expect(await f.client().models.setWorkerSelection({ ...scope, selection: null })).toEqual(
      expected,
    );
    expect(await f.client().models.setWorkerSelection({ ...scope, selection: null })).toEqual(
      expected,
    );
  });
  it("does not authorize reset for anonymous, foreign or invented participants", async () => {
    const f = fixture();
    await expect(
      f.client(false).models.setWorkerSelection({ ...scope, selection: null }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      f
        .client()
        .models.setWorkerSelection({ ...scope, participantId: "invented", selection: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    f.db.thread.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      f.client().models.setWorkerSelection({ ...scope, selection: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.db.runtimeModelPreference.deleteMany).not.toHaveBeenCalled();
  });
  it("retains a failed handoff and old effective configuration when retrying the same intent", async () => {
    const f = fixture();
    await f.client().models.setWorkerSelection({ ...scope, selection });
    const failure = {
      requested: selection,
      effective: old,
      status: "failed",
      error: "Retry required",
    };
    f.state.participants.worker.session.modelSelection = failure;
    expect(await f.client().models.setWorkerSelection({ ...scope, selection })).toEqual(failure);
  });
  it("keeps hidden requested pins visible as failed without rerouting or changing effective state", async () => {
    const f = fixture();
    await f.client().models.setWorkerSelection({ ...scope, selection });
    f.db.user.findUnique.mockResolvedValue({
      modelVisibility: { hide: [{ provider: selection.provider, model: selection.modelId }] },
    });
    expect(await f.client().models.getSelection(scope)).toMatchObject({
      requested: selection,
      effective: old,
      status: "failed",
      error: expect.stringContaining("hidden"),
    });
    expect(f.db.user.findUnique).toHaveBeenCalledWith({
      where: { id: actor.userId },
      select: { modelVisibility: true },
    });
    f.db.runtimeModelPreference.upsert.mockClear();
    await expect(
      f.client().models.setWorkerSelection({ ...scope, selection }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("hidden") });
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
    expect(await f.client().models.setWorkerSelection({ ...scope, selection: null })).toMatchObject(
      { requested: old, effective: old, status: "applied" },
    );
  });
  it("preserves a hidden bot pin rather than showing the Space default", async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValue({
      modelVisibility: { hide: [{ provider: old.provider }] },
    });
    expect(
      await f.client().models.getSelection({ botId: scope.botId, threadId: scope.threadId }),
    ).toMatchObject({
      requested: old,
      effective: old,
      status: "failed",
      error: expect.stringContaining("hidden"),
    });
  });
  it("pins the deployment default through the authenticated worker route without a credential row", async () => {
    const f = fixture();
    f.db.spaceModelPreference.findFirst.mockResolvedValue(null as never);
    f.db.userModelCredential.findFirst.mockResolvedValue(null as never);
    const selected = { provider: "openai", modelId: "gpt-4o", thinkingLevel: null };
    const env = {
      defaultProvider: selected.provider,
      defaultModel: selected.modelId,
      deploymentModelKey: "fake-deployment-key",
    };
    expect(
      await f.client(true, env).models.setWorkerSelection({ ...scope, selection: selected }),
    ).toMatchObject({ requested: selected, effective: old, status: "pending" });
    expect(f.db.secret.findFirst).not.toHaveBeenCalled();
    f.db.runtimeModelPreference.upsert.mockClear();
    await expect(
      f.client().models.setWorkerSelection({ ...scope, selection: selected }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    f.db.user.findUnique.mockResolvedValueOnce({
      modelVisibility: { hide: [{ provider: selected.provider }] },
    });
    await expect(
      f.client(true, env).models.setWorkerSelection({ ...scope, selection: selected }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("hidden") });
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("validates connected models through the actual authorized route", async () => {
    const f = fixture();
    const result = await f.client().models.setWorkerSelection({ ...scope, selection });
    expect(result).toMatchObject({ requested: selection, effective: old, status: "pending" });
    expect(f.db.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret", userId: actor.userId, spaceId: null },
      select: { ciphertext: true },
    });
  });
});
