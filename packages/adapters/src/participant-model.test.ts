import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { resolveParticipantModel } from "./participant-model.js";

const selection = {
  provider: "openai-compatible",
  modelId: "pinned",
  thinkingLevel: "high" as const,
};
function fixture() {
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        modelVisibility: { hide: [] as Array<{ provider: string; model?: string }> },
      })),
    },
    runtimeModelPreference: { findUnique: vi.fn(async () => ({ selection })), upsert: vi.fn() },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        credential: { secretId: "secret", provider: selection.provider },
        isDefault: true,
        modelId: "default",
      })),
    },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => ({ id: "secret" })) },
  };
  const input = {
    prisma: db as unknown as PrismaClient,
    scope: { spaceId: "space", userId: "owner", threadId: "thread", botId: "bot" },
    participantId: "stable-worker",
    resolve: vi.fn(async () => ({
      apiKey: "fake",
      baseUrl: "http://offline.invalid/v1",
      reasoning: true,
    })),
  };
  return { db, input };
}
describe("persisted participant model resolution", () => {
  it("uses the durable requested pin, not the changed parent/run configuration", async () => {
    const f = fixture();
    expect(await resolveParticipantModel(f.input)).toMatchObject({
      provider: selection.provider,
      id: "pinned",
      thinkingLevel: "high",
      apiKey: "fake",
    });
    expect(f.db.runtimeModelPreference.findUnique).toHaveBeenCalledWith({
      where: {
        spaceId_threadId_botId_participantId: {
          spaceId: "space",
          threadId: "thread",
          botId: "bot",
          participantId: "stable-worker",
        },
      },
    });
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("stores explicit worker model/effort choices without saving credentials", async () => {
    const f = fixture();
    await resolveParticipantModel({ ...f.input, selection });
    expect(JSON.stringify(f.db.runtimeModelPreference.upsert.mock.calls)).not.toContain("fake");
    expect(f.db.runtimeModelPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { selection } }),
    );
  });
  it("inherits the bot after reset instead of retaining a child checkpoint request", async () => {
    const f = fixture();
    f.db.runtimeModelPreference.findUnique.mockResolvedValueOnce(null as never);
    expect(await resolveParticipantModel(f.input)).toBeUndefined();
    expect(f.input.resolve).not.toHaveBeenCalled();
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("rejects a newly hidden persisted worker before reading credentials", async () => {
    const f = fixture();
    f.db.user.findUnique.mockResolvedValueOnce({
      modelVisibility: { hide: [{ provider: selection.provider, model: selection.modelId }] },
    });
    await expect(resolveParticipantModel(f.input)).rejects.toThrow("hidden");
    expect(f.input.resolve).not.toHaveBeenCalled();
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
  });
  it("resolves an exact deployment-backed worker pin without fabricating a credential", async () => {
    const f = fixture();
    f.db.spaceModelPreference.findFirst.mockResolvedValue(null as never);
    const input = {
      ...f.input,
      deployment: { provider: selection.provider, model: selection.modelId },
    };
    expect(await resolveParticipantModel(input)).toMatchObject({
      provider: selection.provider,
      id: selection.modelId,
      thinkingLevel: "high",
    });
    expect(f.input.resolve).toHaveBeenCalledWith(null, selection.provider);
    expect(f.db.secret.findFirst).not.toHaveBeenCalled();
    f.input.resolve.mockClear();
    await expect(
      resolveParticipantModel({
        ...input,
        deployment: { ...input.deployment, model: "other-model" },
      }),
    ).rejects.toThrow("connection unavailable");
    expect(f.input.resolve).not.toHaveBeenCalled();
  });
  it("never substitutes deployment auth for a revoked owned worker secret", async () => {
    const f = fixture();
    f.db.secret.findFirst.mockResolvedValue(null as never);
    await expect(
      resolveParticipantModel({
        ...f.input,
        deployment: { provider: selection.provider, model: selection.modelId },
      }),
    ).rejects.toThrow("connection unavailable");
    expect(f.input.resolve).not.toHaveBeenCalled();
  });
  it("fails closed if the owned secret was revoked", async () => {
    const f = fixture();
    f.db.secret.findFirst.mockResolvedValueOnce(null as never);
    await expect(resolveParticipantModel(f.input)).rejects.toThrow("connection unavailable");
    expect(f.input.resolve).not.toHaveBeenCalled();
  });
});
