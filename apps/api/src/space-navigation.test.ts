import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const bots = vi.hoisted(() =>
  [null, "parent-bot"].map((parentBotId, index) => ({
    id: `bot-${index}`,
    parentBotId,
    spaceId: "other-space",
    name: `Bot ${index}`,
    title: "Helper",
    color: "#3EC5A8",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    unread: false,
    preview: "",
    status: "idle",
    updatedAt: new Date(0).toISOString(),
  })),
);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  createRepos: () => ({
    listBots: vi.fn().mockResolvedValue([]),
    listSpaceBotsForSpaces: vi.fn().mockResolvedValue(bots),
    listBotSectionsForSpaces: vi.fn().mockResolvedValue([]),
  }),
  createGroupRepos: () => ({
    listGroups: vi.fn().mockResolvedValue([]),
    listSpaceGroupsForSpaces: vi.fn().mockResolvedValue([]),
  }),
  createExternalConversationRepos: () => ({ listForSpaces: vi.fn().mockResolvedValue([]) }),
}));

describe("space navigation", () => {
  it("retains parent identity for root and child bots in inactive spaces", async () => {
    const deps = {
      prisma: {
        space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "organization" }) },
        spaceMember: {
          findMany: vi.fn().mockResolvedValue(
            ["space", "other-space"].map((spaceId) => ({
              spaceId,
              role: "owner",
              space: { name: spaceId, isDefault: spaceId === "space", deletingAt: null },
            })),
          ),
        },
        bot: { findMany: vi.fn().mockResolvedValue([{ spaceId: "other-space" }]) },
        chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
      },
      env: { agentRuntime: "pi" },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("http://localhost/rpc/spaces/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      {
        prefix: "/rpc",
        context: {
          actor: {
            userId: "user",
            spaceId: "space",
            email: "user@example.test",
            isDeploymentOwner: true,
          },
        },
      },
    );
    expect(response.status).toBe(200);
    const { json } = await response.json();
    expect(json.spaces.find((space: { id: string }) => space.id === "other-space").bots).toEqual([
      expect.objectContaining({ id: "bot-0", parentBotId: null }),
      expect.objectContaining({ id: "bot-1", parentBotId: "parent-bot" }),
    ]);
  });
});
