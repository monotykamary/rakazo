import type { ModelVisibility } from "@rakazo/contracts";
import { ModelHiddenError } from "@rakazo/contracts";
import { type PrismaClient, setModelVisibility } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { dispatchWork } from "./dispatched-work.js";
import { resolveParticipantModel } from "./participant-model.js";

const { createBot, reachedCreation } = vi.hoisted(() => {
  const reachedCreation = new Error("Reached authorized worker creation");
  return {
    reachedCreation,
    createBot: vi.fn(async () => {
      throw reachedCreation;
    }),
  };
});
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  createRepos: () => ({ createBot }),
}));

function fixture() {
  createBot.mockClear();
  const selection = { provider: "openai-compatible", modelId: "pinned", thinkingLevel: null };
  const users = new Map<string, { modelVisibility: ModelVisibility }>([
    ["owner", { modelVisibility: { hide: [] } }],
    ["other", { modelVisibility: { hide: [] } }],
  ]);
  const db = {
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { modelVisibility: ModelVisibility };
        }) => {
          const user = users.get(where.id);
          if (!user) return { count: 0 };
          user.modelVisibility = data.modelVisibility;
          return { count: 1 };
        },
      ),
    },
    bot: {
      findFirst: vi.fn(async () => ({
        id: "bot",
        modelProvider: selection.provider,
        modelId: selection.modelId,
        thinkingLevel: null,
      })),
      findUnique: vi.fn(async () => null),
    },
    run: {
      findFirst: vi.fn(async () => ({
        modelProvider: selection.provider,
        modelId: selection.modelId,
      })),
    },
    dispatchedWork: { findUnique: vi.fn(async () => null) },
    runtimeModelPreference: { findUnique: vi.fn(async () => ({ selection })), upsert: vi.fn() },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        credential: { secretId: "secret", provider: selection.provider },
        modelId: selection.modelId,
      })),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret" })) },
  };
  const prisma = db as unknown as PrismaClient;
  const source = { id: "run", userId: "owner", spaceId: "space", threadId: "thread", botId: "bot" };
  const placement = { computerId: "computer", homeKey: "home", projectPath: "project" };
  const deps = {
    prisma,
    jobs: { enqueue: vi.fn() },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof dispatchWork>[0];
  return { db, prisma, selection, source, placement, deps };
}

describe("canonical owner visibility at worker consumers", () => {
  it.each([true, false])(
    "rejects hidden dispatch models before creating workers (explicit: %s), with owner isolation and unhide",
    async (explicit) => {
      const f = fixture();
      const input = {
        task: "Review files",
        project_path: "project",
        ...(explicit ? { model: f.selection } : {}),
      };
      for (const rule of [
        { provider: f.selection.provider },
        { provider: f.selection.provider, model: f.selection.modelId },
      ]) {
        await setModelVisibility(f.prisma, f.source, { hide: [rule] });
        const before = createBot.mock.calls.length;
        await expect(
          dispatchWork(f.deps, f.source, input, "request", f.placement),
        ).rejects.toBeInstanceOf(ModelHiddenError);
        expect(createBot).toHaveBeenCalledTimes(before);
        await expect(
          dispatchWork(
            f.deps,
            { ...f.source, userId: "other" },
            input,
            "other-request",
            f.placement,
          ),
        ).rejects.toBe(reachedCreation);
        expect(createBot).toHaveBeenCalledTimes(before + 1);
        await setModelVisibility(f.prisma, f.source, { hide: [] });
        await expect(dispatchWork(f.deps, f.source, input, "request", f.placement)).rejects.toBe(
          reachedCreation,
        );
        expect(createBot).toHaveBeenCalledTimes(before + 2);
      }
      expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it("restores the original participant pin after unhide without overwriting intent or crossing owners", async () => {
    const f = fixture();
    const resolve = vi.fn(async () => ({
      apiKey: "fake-offline-key",
      baseUrl: "http://invalid.invalid",
    }));
    const input = { prisma: f.prisma, scope: f.source, participantId: "worker", resolve };
    await setModelVisibility(f.prisma, f.source, { hide: [{ provider: f.selection.provider }] });
    await expect(resolveParticipantModel(input)).rejects.toBeInstanceOf(ModelHiddenError);
    expect(resolve).not.toHaveBeenCalled();
    expect(f.db.secret.findFirst).not.toHaveBeenCalled();
    expect(
      await resolveParticipantModel({ ...input, scope: { ...f.source, userId: "other" } }),
    ).toMatchObject({ id: "pinned" });
    await setModelVisibility(f.prisma, f.source, { hide: [] });
    expect(await resolveParticipantModel(input)).toMatchObject({
      provider: f.selection.provider,
      id: f.selection.modelId,
    });
    expect(f.db.runtimeModelPreference.upsert).not.toHaveBeenCalled();
  });
});
