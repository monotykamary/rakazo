import type { VisionHandoff } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { getVisionHandoff, setVisionHandoff } from "./vision-handoff.js";

function fixture() {
  const users = new Map<string, { visionHandoff: VisionHandoff | null }>([
    ["owner", { visionHandoff: { enabled: false, visionModel: null } }],
  ]);
  const prisma = {
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
  } as unknown as PrismaClient;
  return { users, prisma };
}

describe("vision handoff storage", () => {
  it("returns the default when unset and isolates missing owners", async () => {
    const f = fixture();
    f.users.set("empty", { visionHandoff: null });
    expect(await getVisionHandoff(f.prisma, { userId: "empty" })).toEqual({
      enabled: false,
      visionModel: null,
    });
    await expect(getVisionHandoff(f.prisma, { userId: "missing" })).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
  it("stores a canonical describer and rejects missing owners", async () => {
    const f = fixture();
    const next = { enabled: true, visionModel: "openai/gpt-4.1" };
    expect(await setVisionHandoff(f.prisma, { userId: "owner" }, next)).toEqual(next);
    expect(await getVisionHandoff(f.prisma, { userId: "owner" })).toEqual(next);
    await expect(setVisionHandoff(f.prisma, { userId: "missing" }, next)).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});
