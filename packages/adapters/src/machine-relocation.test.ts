import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { assignBotMachine } from "./machine-assignment.js";
import {
  type MachineRelocationDeps,
  type RelocationComputer,
  relocateBotMachine,
} from "./machine-relocation.js";
import { copyAgentHome } from "./workspace-transfer.js";

vi.mock("./workspace-transfer.js", () => ({ copyAgentHome: vi.fn(), teamBotAreaFilter: vi.fn() }));
vi.mock("./computer-workspace.js", () => ({ checkpointAndRecordComputerWorkspace: vi.fn() }));
const actor = { spaceId: "space", userId: "owner" } as Actor;
function fixture() {
  const current: RelocationComputer = {
    id: "source",
    scope: "dedicated",
    homeKey: "source-home",
    homeRevision: "rev",
    kind: "machine",
    providerRef: "source-ref",
    state: "running",
    machineId: "machine-a",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
  };
  const bot = { id: "bot", computer: current };
  const prisma = {
    run: { findFirst: vi.fn().mockResolvedValue(null) },
    bot: {
      findFirst: vi.fn().mockResolvedValue(bot),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    computerExecutionLease: {
      findFirst: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    dispatchedWork: { findFirst: vi.fn().mockResolvedValue(null) },
    computer: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    machine: { findFirst: vi.fn().mockResolvedValue({ id: "target" }) },
    officeMoveIntent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  const sandbox = { stop: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(copyAgentHome)
    .mockReset()
    .mockResolvedValue({
      revision: "verified",
      manifest: { entries: [{ path: "file" }] },
    } as never);
  return {
    current,
    prisma,
    sandbox,
    deps: { prisma, sandbox, home: {} } as unknown as MachineRelocationDeps,
  };
}
describe("shared verified machine relocation", () => {
  it("rolls a transfer failure back without switching or stopping the source", async () => {
    const { deps, current, prisma, sandbox } = fixture();
    vi.mocked(copyAgentHome).mockRejectedValue(new Error("verification failed"));
    await expect(
      relocateBotMachine(deps, actor, { botId: "bot", current, machineId: "target" }),
    ).rejects.toThrow("verification failed");
    expect(prisma.bot.updateMany).not.toHaveBeenCalled();
    expect(sandbox.stop).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).toHaveBeenLastCalledWith({
      where: { id: "source", state: "suspending", providerRef: "source-ref" },
      data: { state: "running" },
    });
  });
  it("refuses a failed source stop and marks uncertain state without changing assignment", async () => {
    const { deps, current, prisma, sandbox } = fixture();
    sandbox.stop.mockRejectedValue(new Error("unreachable"));
    await expect(
      relocateBotMachine(deps, actor, { botId: "bot", current, machineId: "target" }),
    ).rejects.toThrow("could not be stopped");
    expect(prisma.bot.updateMany).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { state: "failed" } }),
    );
  });
  it("rechecks pairing in the commit after transfer and preserves the source assignment on revocation", async () => {
    const { deps, current, prisma } = fixture();
    prisma.machine.findFirst.mockResolvedValue(null);
    await expect(
      relocateBotMachine(deps, actor, { botId: "bot", current, machineId: "target" }),
    ).rejects.toThrow("no longer paired");
    expect(prisma.bot.updateMany).not.toHaveBeenCalled();
    expect(prisma.computer.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { state: "stopped" } }),
    );
  });
  it("commits verified assignment and durable completion together", async () => {
    const { deps, current, prisma } = fixture();
    await relocateBotMachine({ ...deps, intentId: "intent", intentClaimToken: "claim" }, actor, {
      botId: "bot",
      current,
      machineId: "target",
    });
    expect(prisma.officeMoveIntent.updateMany).toHaveBeenCalledWith({
      where: { id: "intent", status: "processing", claimToken: "claim" },
      data: { status: "completed", resultComputerId: expect.any(String) },
    });
    expect(prisma.bot.updateMany).toHaveBeenCalledWith({
      where: { id: "bot", ...actor, computerId: "source", computerSwitching: true },
      data: { computerId: expect.any(String), computerSwitching: false, officeMoveIntentId: null },
    });
  });
  it("cannot commit after the session fence is lost during external copying", async () => {
    const { deps, current, prisma } = fixture();
    let lost = false;
    vi.mocked(copyAgentHome).mockImplementation(async () => {
      lost = true;
      return { revision: "verified", manifest: { entries: [{ path: "file" }] } } as never;
    });
    await expect(
      relocateBotMachine(
        {
          ...deps,
          intentId: "intent",
          intentClaimToken: "claim",
          assertMoveClaim: () => {
            if (lost) throw new Error("lock lost");
          },
        },
        actor,
        { botId: "bot", current, machineId: "target" },
      ),
    ).rejects.toThrow("lock lost");
    expect(prisma.bot.updateMany).not.toHaveBeenCalled();
    expect(prisma.officeMoveIntent.updateMany).not.toHaveBeenCalled();
  });
  it("places expected source in the assignment latch CAS, not only a precheck", async () => {
    const { deps, prisma } = fixture();
    prisma.bot.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      assignBotMachine(deps, actor, {
        botId: "bot",
        machineId: "target",
        expectedComputerId: "source",
        intentId: "intent",
        intentClaimToken: "claim",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.bot.updateMany).toHaveBeenCalledWith({
      where: { id: "bot", ...actor, computerSwitching: false, computerId: "source" },
      data: { computerSwitching: true, officeMoveIntentId: "intent" },
    });
    expect(copyAgentHome).not.toHaveBeenCalled();
    expect(prisma.officeMoveIntent.updateMany).not.toHaveBeenCalled();
  });
  it("rechecks source under the acquired latch", async () => {
    const { deps, prisma } = fixture();
    await expect(
      assignBotMachine(deps, actor, {
        botId: "bot",
        machineId: "target",
        expectedComputerId: "old-source",
        intentId: "intent",
        intentClaimToken: "claim",
      }),
    ).rejects.toThrow("Source assignment changed");
    expect(copyAgentHome).not.toHaveBeenCalled();
    expect(prisma.bot.updateMany).toHaveBeenLastCalledWith({
      where: { id: "bot", officeMoveIntentId: "intent" },
      data: { computerSwitching: false, officeMoveIntentId: null },
    });
  });
});
