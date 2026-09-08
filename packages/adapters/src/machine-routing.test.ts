import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachineRouting } from "./machine-routing.js";

const context: AdapterContext = {
  operationId: "routing-test",
  traceId: "routing-test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

function prismaStub(overrides: {
  computer?: { machineId: string | null } | null;
  bot?: { computer: { machineId: string | null } | null } | null;
}) {
  return {
    computer: { findFirst: vi.fn(async () => overrides.computer ?? null) },
    bot: { findFirst: vi.fn(async () => overrides.bot ?? null) },
  } as unknown as PrismaClient & {
    computer: { findFirst: ReturnType<typeof vi.fn> };
    bot: { findFirst: ReturnType<typeof vi.fn> };
  };
}

const fetchByMachine = vi.fn(
  (machineId: string) =>
    (async (input: string | URL | Request, init?: RequestInit) =>
      Response.json({ id: "container-1", resumed: false, machineId })) as unknown as Response,
);

afterEach(() => {
  vi.clearAllMocks();
});

describe("createMachineRouting", () => {
  it("routes provision to the assigned machine and binds the ref", async () => {
    const prisma = prismaStub({ computer: { machineId: "mach1" } });
    const machineFetch = vi.fn(() => fetchByMachine("mach1") as unknown as typeof fetch);
    const routing = createMachineRouting({ prisma, machineFetch });
    const created = await routing.sandbox.provision(
      { botId: "home-key", homePath: "/ignored" },
      context,
    );
    expect(created.id).toBe("machine:mach1:container-1");
    expect(created.kind).toBe("machine");
    expect(prisma.computer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { homeKey: "home-key", spaceId: "space-1" } }),
    );
    expect(machineFetch).toHaveBeenCalledWith("mach1");
  });

  it("routes unassigned bots to the fallback sandbox", async () => {
    const prisma = prismaStub({ computer: null });
    const fallback = {
      provision: vi.fn(async () => ({
        id: "c2",
        botId: "b",
        kind: "docker" as const,
        providerRef: "c2",
      })),
    };
    const routing = createMachineRouting({
      prisma,
      machineFetch: vi.fn(() => undefined as unknown as typeof fetch),
      fallbackSandbox: fallback as never,
    });
    const created = await routing.sandbox.provision(
      { botId: "home-key", homePath: "/ignored" },
      context,
    );
    expect(created.id).toBe("c2");
    expect(fallback.provision).toHaveBeenCalled();
  });

  it("throws an isolation error for an unassigned bot without a fallback sandbox", async () => {
    const prisma = prismaStub({ computer: null });
    const routing = createMachineRouting({
      prisma,
      machineFetch: vi.fn(() => undefined as unknown as typeof fetch),
    });
    await expect(
      routing.sandbox.provision({ botId: "home-key", homePath: "/ignored" }, context),
    ).rejects.toThrow(/no backend-local sandbox/i);
  });

  it("routes run starts to the bot's assigned machine host", async () => {
    const prisma = prismaStub({ bot: { computer: { machineId: "mach1" } } });
    const machineFetch = vi.fn(
      () => (async () => Response.json({ id: "agent-1" })) as unknown as typeof fetch,
    );
    const routing = createMachineRouting({ prisma, machineFetch });
    const scope = {
      runId: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      spaceId: "space-1",
    };
    const start = routing.host.start(scope, new AbortController().signal);
    await vi.waitFor(() => {
      expect(machineFetch).toHaveBeenCalledWith("mach1");
    });
    // The tunnel request reaches the machine's /agents authority with root-run headers.
    start.then(
      (connection) => connection.stop(),
      () => undefined,
    );
    expect(prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bot-1", spaceId: "space-1", archivedAt: null } }),
    );
  });

  it("throws instead of falling back when an assigned bot is missing from the database", async () => {
    const prisma = prismaStub({ bot: null });
    const routing = createMachineRouting({
      prisma,
      machineFetch: vi.fn(() => undefined as unknown as typeof fetch),
    });
    await expect(
      routing.host.start(
        { runId: "run-1", threadId: "t", botId: "bot-1", spaceId: "space-1" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/refusing to start/i);
  });

  it("falls back to the backend host only for unassigned bots with one configured", async () => {
    const prisma = prismaStub({ bot: { computer: null } });
    const fallbackHost = {
      start: vi.fn(async () => ({ rpc: null, bridge: null, stop: async () => undefined })),
    };
    const routing = createMachineRouting({
      prisma,
      machineFetch: vi.fn(() => undefined as unknown as typeof fetch),
      fallbackHost: fallbackHost as never,
    });
    await routing.host.start(
      { runId: "run-1", threadId: "t", botId: "bot-1", spaceId: "space-1" },
      new AbortController().signal,
    );
    expect(fallbackHost.start).toHaveBeenCalled();
  });

  it("fails closed for an unassigned bot without a fallback host", async () => {
    const prisma = prismaStub({ bot: { computer: null } });
    const routing = createMachineRouting({
      prisma,
      machineFetch: vi.fn(() => undefined as unknown as typeof fetch),
    });
    await expect(
      routing.host.start(
        { runId: "run-1", threadId: "t", botId: "bot-1", spaceId: "space-1" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/no backend-local isolation host/i);
  });

  it("resolves machine-bound cleanup refs to their owning machine after reassignment", async () => {
    const prisma = prismaStub({ computer: { machineId: "mach1" } });
    const mach2Fetch = vi.fn(
      () => (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    );
    const machineFetch = vi.fn((machineId: string) =>
      machineId === "mach2"
        ? (mach2Fetch() as unknown as typeof fetch)
        : (fetchByMachine(machineId) as unknown as typeof fetch),
    );
    const routing = createMachineRouting({ prisma, machineFetch });
    await routing.sandbox.stop(
      {
        id: "machine:mach2:container-9",
        botId: "bot-1",
        kind: "machine",
        providerRef: "machine:mach2:container-9",
      },
      context,
    );
    expect(machineFetch).toHaveBeenCalledWith("mach2");
  });
});
