import { createRouterClient } from "@orpc/server";
import type { Actor, VisionHandoff } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

function fixture() {
  const users = new Map<string, { visionHandoff: VisionHandoff }>([
    ["owner", { visionHandoff: { enabled: false, visionModel: null } }],
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
          data: { visionHandoff: VisionHandoff };
        }) => {
          const user = users.get(where.id);
          if (!user) return { count: 0 };
          user.visionHandoff = data.visionHandoff;
          return { count: 1 };
        },
      ),
    },
  };
  const prisma = db as never;
  const router = createRouter({
    prisma,
    env: {},
    secrets: {},
    sandbox: {},
    home: {},
    events: {},
    jobs: {},
  } as unknown as RouterDeps);
  const client = (userId: string | null = "owner") =>
    createRouterClient(router, {
      context: {
        actor:
          userId === null ? null : ({ userId, spaceId: "space", isDeploymentOwner: true } as Actor),
      },
    });
  return { users, db, client };
}

describe("authenticated vision handoff", () => {
  it("rejects unauthenticated access before reading or writing", async () => {
    const f = fixture();
    await expect(f.client(null).models.getVisionHandoff()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      f.client(null).models.setVisionHandoff({ enabled: false, visionModel: null }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.db.user.findUnique).not.toHaveBeenCalled();
    expect(f.db.user.updateMany).not.toHaveBeenCalled();
  });
  it("stores a vision-capable describer for the deployment owner", async () => {
    const f = fixture();
    expect(await f.client().models.getVisionHandoff()).toEqual({
      enabled: false,
      visionModel: null,
    });
    const next = { enabled: true, visionModel: "openai/gpt-4.1" };
    expect(await f.client().models.setVisionHandoff(next)).toEqual(next);
    expect(await f.client().models.getVisionHandoff()).toEqual(next);
  });
  it("rejects a text-only or malformed describer", async () => {
    const f = fixture();
    await expect(
      f.client().models.setVisionHandoff({ enabled: true, visionModel: "openai/*" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.db.user.updateMany).not.toHaveBeenCalled();
  });
});
