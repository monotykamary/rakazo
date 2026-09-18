import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { mergeConnectedPlugins } from "./composio-connector.js";
import { persistLivePluginConnections, selectRunConnections } from "./executor.js";

describe("run connection selection", () => {
  it("uses persisted account statuses in the current run", async () => {
    const rows = [
      { id: "gmail", provider: "gmail", status: "error" },
      { id: "slack", provider: "slack", status: "revoked" },
      { id: "slack-old", provider: "slack", status: "revoked" },
      { id: "gmail-old", provider: "gmail", status: "pending" },
    ].map((row) => ({ ...row, connectorId: "composio", displayName: row.provider }));
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = { connection: { updateMany } } as unknown as PrismaClient;
    await persistLivePluginConnections(prisma, { userId: "user", spaceId: "space" }, rows, [
      "gmail",
      "slack",
    ]);
    expect(rows.map((row) => row.status)).toEqual(["connected", "connected", "revoked", "revoked"]);
    expect(
      selectRunConnections(
        rows,
        mergeConnectedPlugins(rows, ["gmail", "slack"]).map((row) => row.provider),
      ),
    ).toEqual([rows[0], rows[1]]);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user", spaceId: "space" }),
      }),
    );
  });

  it("does not recover a revoked account if persistence fails", async () => {
    const rows = [
      {
        id: "old",
        connectorId: "composio",
        provider: "mail",
        displayName: "Mail",
        status: "revoked",
      },
    ];
    const prisma = {
      connection: { updateMany: vi.fn().mockRejectedValue(new Error("unavailable")) },
    } as unknown as PrismaClient;
    await expect(
      persistLivePluginConnections(prisma, { userId: "user", spaceId: "space" }, rows, ["mail"]),
    ).rejects.toThrow("unavailable");
    expect(selectRunConnections(rows, ["mail"])).toEqual([]);
  });

  it("never includes revoked accounts alongside a reconnected toolkit", () => {
    const old = {
      connectorId: "composio",
      provider: "mail",
      status: "revoked",
      providerRef: "old",
    };
    const current = { ...old, status: "connected", providerRef: "current" };
    const pending = { ...old, status: "pending", providerRef: "pending" };
    const other = { ...old, connectorId: "pipedream", status: "connected" };
    expect(selectRunConnections([old, current, pending, other], ["mail"])).toEqual([
      current,
      pending,
      other,
    ]);
  });
});
