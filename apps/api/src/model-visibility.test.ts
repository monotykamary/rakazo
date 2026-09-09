import { createRouterClient } from "@orpc/server";
import type { Actor, ModelVisibility } from "@rakazo/contracts";
import { getModelVisibility, type PrismaClient } from "@rakazo/db";
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
  it("retires visibility writes without touching stored preferences", async () => {
    const f = fixture();
    await expect(f.client().models.setVisibility({ hide: [] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Models are configured in Pi",
    });
    expect(f.db.user.updateMany).not.toHaveBeenCalled();
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
    await expect(getModelVisibility(f.prisma, { userId: "missing" })).rejects.toThrow();
    await expect(f.client("missing").models.setVisibility({ hide: [] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    f.users.get("owner")!.modelVisibility = { hide: [{ provider: "test", model: "*" }] };
    await expect(getModelVisibility(f.prisma, { userId: "owner" })).rejects.toThrow();
  });
});
