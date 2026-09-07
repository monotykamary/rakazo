import { createRouterClient } from "@orpc/server";
import type { Actor, ModelVisibility } from "@rakazo/contracts";
import { assertModelVisibleForOwner, getModelVisibility, type PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

function fixture() {
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
    secret: { update: vi.fn(), delete: vi.fn() },
    userModelCredential: { update: vi.fn(), delete: vi.fn() },
  };
  const prisma = db as unknown as PrismaClient;
  const router = createRouter({
    prisma,
    env: {},
    secrets: {},
    sandbox: {},
    home: {},
    events: {},
    jobs: {},
  } as unknown as RouterDeps);
  const client = (userId: string | null = "owner", spaceId = "space") =>
    createRouterClient(router, {
      context: { actor: userId === null ? null : ({ userId, spaceId } as Actor) },
    });
  return { users, db, prisma, client };
}

describe("authenticated model visibility", () => {
  it("registers all routes and rejects unauthenticated access before reading or writing", async () => {
    const f = fixture();
    await expect(f.client(null).models.getVisibility()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(f.client(null).models.setVisibility({ hide: [] })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(f.client(null).models.listForVisibility()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(f.client(null).models.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.user.updateMany).not.toHaveBeenCalled();
  });
  it("hides/unhides the real catalog per owner across spaces without credential mutation", async () => {
    const f = fixture();
    const client = f.client();
    const all = await client.models.listForVisibility();
    const model = all.find((entry) => !entry.placeholder)!;
    expect(model).toBeDefined();
    const rule = { provider: model.provider, model: model.id };
    expect(await client.models.setVisibility({ hide: [rule, rule] })).toEqual({ hide: [rule] });
    expect(await f.client("owner", "another-space").models.getVisibility()).toEqual({
      hide: [rule],
    });
    expect(await client.models.list()).not.toContainEqual(model);
    expect(await f.client("other").models.list()).toContainEqual(model);
    expect(await client.models.listForVisibility()).toContainEqual(model);
    await expect(
      assertModelVisibleForOwner(f.prisma, { userId: "owner" }, model.provider, model.id),
    ).rejects.toThrow("Unhide it");
    await expect(
      assertModelVisibleForOwner(f.prisma, { userId: "other" }, model.provider, model.id),
    ).resolves.toBeUndefined();
    await client.models.setVisibility({ hide: [{ provider: model.provider }] });
    expect((await client.models.list()).some((entry) => entry.provider === model.provider)).toBe(
      false,
    );
    await client.models.setVisibility({ hide: [] });
    expect(await client.models.list()).toEqual(all);
    await expect(
      assertModelVisibleForOwner(f.prisma, { userId: "owner" }, model.provider, model.id),
    ).resolves.toBeUndefined();
    expect(f.db.secret.update).not.toHaveBeenCalled();
    expect(f.db.secret.delete).not.toHaveBeenCalled();
    expect(f.db.userModelCredential.update).not.toHaveBeenCalled();
    expect(f.db.userModelCredential.delete).not.toHaveBeenCalled();
  });
  it("rejects authority injection and unsafe patterns before storage", async () => {
    const f = fixture();
    await expect(
      f
        .client()
        .models.setVisibility({ hide: [{ provider: "test", model: `${"a*".repeat(100)}b` }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.client().models.setVisibility({ hide: [], userId: "other" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.db.user.updateMany).not.toHaveBeenCalled();
  });
  it("does not silently enable models for missing owners or corrupt preferences", async () => {
    const f = fixture();
    await expect(f.client("missing").models.getVisibility()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(f.client("missing").models.setVisibility({ hide: [] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    f.users.get("owner")!.modelVisibility = { hide: [{ provider: "test", model: "*" }] };
    await expect(getModelVisibility(f.prisma, { userId: "owner" })).rejects.toThrow();
  });
});
