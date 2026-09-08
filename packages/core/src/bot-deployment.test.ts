import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BotDeploymentController,
  currentMachine,
  isLocalManagedOrigin,
  isPairedMachine,
  type MachineGateway,
  type MachineSummary,
  machinePairingCommand,
  orderedMachineChoices,
  pairingPhase,
} from "./bot-deployment.js";

const machine = (overrides: Partial<MachineSummary> & { id: string }): MachineSummary => ({
  name: overrides.id,
  status: "online",
  version: null,
  lastSeenAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function gateway(overrides: Partial<MachineGateway> = {}): MachineGateway {
  return {
    list: vi.fn(async () => []),
    startPairing: vi.fn(async () => ({
      pairingId: "pair-1",
      code: "rk_p_ABC",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    cancelPairing: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    assignment: vi.fn(async () => null),
    assign: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isPairedMachine", () => {
  it("accepts online and offline machines, not pending or revoked", () => {
    expect(isPairedMachine(machine({ id: "a", status: "online" }))).toBe(true);
    expect(isPairedMachine(machine({ id: "a", status: "offline" }))).toBe(true);
    expect(isPairedMachine(machine({ id: "a", status: "pending" }))).toBe(false);
    expect(isPairedMachine(machine({ id: "a", status: "revoked" }))).toBe(false);
  });
});

describe("currentMachine", () => {
  it("uses the assignment and never invents a default row", () => {
    const machines = [machine({ id: "a" }), machine({ id: "b", status: "offline" })];
    expect(currentMachine("a", machines)?.id).toBe("a");
    expect(currentMachine(null, machines)).toBeNull();
    expect(currentMachine("gone", machines)).toBeNull();
  });
});

describe("orderedMachineChoices", () => {
  it("lists paired machines, online first, and hides pending/revoked", () => {
    const choices = orderedMachineChoices([
      machine({ id: "pending", status: "pending" }),
      machine({ id: "revoked", status: "revoked" }),
      machine({ id: "offline", status: "offline", name: "aaa" }),
      machine({ id: "z-online", name: "zzz" }),
      machine({ id: "a-online", name: "bbb" }),
    ]);
    expect(choices.map((entry) => entry.id)).toEqual(["a-online", "z-online", "offline"]);
  });
});

describe("pairingPhase", () => {
  it("expires past the deadline (with slack)", () => {
    const past = new Date(Date.now() - 30_000).toISOString();
    const fresh = new Date(Date.now() + 30_000).toISOString();
    expect(pairingPhase(past)).toBe("expired");
    expect(pairingPhase(fresh)).toBe("waiting");
  });
});

describe("isLocalManagedOrigin", () => {
  it("flags loopback origins only", () => {
    expect(isLocalManagedOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalManagedOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalManagedOrigin("https://rakazo.example")).toBe(false);
    expect(isLocalManagedOrigin(null)).toBe(false);
    expect(isLocalManagedOrigin("not a url")).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("machinePairingCommand", () => {
  it("round-trips shell metacharacters as arguments, not commands", () => {
    const code = "rk_p_'; printf injected; #$()";
    const command = machinePairingCommand("https://rakazo.example/app", code);
    const args = execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], {
      encoding: "utf8",
    });
    expect(args.trim().split("\n")).toEqual([
      "rakazo-runner",
      "pair",
      "--server",
      "https://rakazo.example",
      "--code",
      code,
    ]);
  });
});

describe("BotDeploymentController", () => {
  it("retains placement when assignment loading fails instead of inventing a default", async () => {
    const assignment = vi
      .fn<MachineGateway["assignment"]>()
      .mockResolvedValueOnce("a")
      .mockRejectedValueOnce(new Error("denied"));
    const controller = new BotDeploymentController(gateway({ assignment }), "bot-1");
    await controller.load();
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      botMachineId: "a",
      error: "denied",
    });
    controller.dispose();
  });

  it("survives StrictMode effect replay and ignores the previous lifecycle's response", async () => {
    const old = deferred<MachineSummary[]>();
    const list = vi
      .fn<MachineGateway["list"]>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue([machine({ id: "new" })]);
    const controller = new BotDeploymentController(gateway({ list }), "bot-1");
    controller.start();
    controller.dispose();
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
    old.resolve([machine({ id: "stale" })]);
    await old.promise;
    await Promise.resolve();
    expect(controller.getSnapshot().machines.map((entry) => entry.id)).toEqual(["new"]);
    controller.dispose();
  });

  it("ignores a cancelled pairing's in-flight poll", async () => {
    vi.useFakeTimers();
    const pending = deferred<MachineSummary[]>();
    const controller = new BotDeploymentController(
      gateway({ list: vi.fn(() => pending.promise) }),
      "bot-1",
      { pollIntervalMs: 10 },
    );
    await controller.startPairing("workshop");
    await vi.advanceTimersByTimeAsync(10);
    await controller.cancelPairing();
    pending.resolve([machine({ id: "pair-1" })]);
    await pending.promise;
    await Promise.resolve();
    expect(controller.getSnapshot().pairing).toBeNull();
    controller.dispose();
  });

  it("does not create two codes on a double submit", async () => {
    const pending = deferred<Awaited<ReturnType<MachineGateway["startPairing"]>>>();
    const startPairing = vi.fn(() => pending.promise);
    const controller = new BotDeploymentController(gateway({ startPairing }), "bot-1");
    const first = controller.startPairing("workshop");
    await controller.startPairing("workshop");
    expect(startPairing).toHaveBeenCalledTimes(1);
    pending.resolve({
      pairingId: "pair-1",
      code: "rk_p_fake",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await first;
    expect(controller.getSnapshot().saving).toBe(false);
    controller.dispose();
  });

  it("cleans up a code created after its caller unmounted", async () => {
    const pending = deferred<Awaited<ReturnType<MachineGateway["startPairing"]>>>();
    const cancelPairing = vi.fn(async () => undefined);
    const controller = new BotDeploymentController(
      gateway({ startPairing: vi.fn(() => pending.promise), cancelPairing }),
      "bot-1",
    );
    const first = controller.startPairing("workshop");
    controller.dispose();
    pending.resolve({
      pairingId: "pair-1",
      code: "rk_p_fake",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await first;
    expect(cancelPairing).toHaveBeenCalledWith("pair-1");
  });

  it("loads machines and the server-side assignment", async () => {
    const assignment = vi.fn(async () => "a");
    const controller = new BotDeploymentController(
      gateway({ list: vi.fn(async () => [machine({ id: "a" })]), assignment }),
      "bot-1",
    );
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ready",
      machines: [{ id: "a" }],
      botMachineId: "a",
    });
    controller.dispose();
  });

  it("surfaces load failures without losing prior state", async () => {
    const list = vi.fn(async () => [machine({ id: "a" })]);
    const controller = new BotDeploymentController(gateway({ list }), "bot-1");
    await controller.load();
    list.mockRejectedValueOnce(new Error("offline"));
    await controller.load();
    expect(controller.getSnapshot().error).toBe("offline");
    expect(controller.getSnapshot().machines).toHaveLength(1);
    controller.dispose();
  });

  it("relays placement choice and refreshes", async () => {
    const assign = vi.fn(async () => undefined);
    const controller = new BotDeploymentController(
      gateway({
        assign,
        list: vi.fn(async () => [machine({ id: "b" })]),
        assignment: vi.fn(async () => "b"),
      }),
      "bot-1",
    );
    await controller.choose("b");
    expect(assign).toHaveBeenCalledWith("bot-1", "b");
    expect(controller.getSnapshot().botMachineId).toBe("b");
    controller.dispose();
  });

  it("relays the default placement with null", async () => {
    const assign = vi.fn(async () => undefined);
    const controller = new BotDeploymentController(gateway({ assign }), "bot-1");
    await controller.choose(null);
    expect(assign).toHaveBeenCalledWith("bot-1", null);
    controller.dispose();
  });

  it("keeps the old assignment when the server rejects placement", async () => {
    const controller = new BotDeploymentController(
      gateway({
        assign: vi.fn(async () => {
          throw new Error("bot is busy");
        }),
      }),
      "bot-1",
    );
    await controller.load();
    await controller.choose("b");
    expect(controller.getSnapshot().error).toBe("bot is busy");
    controller.dispose();
  });

  it("correlates pairing with its own machine, including a joined machine now offline", async () => {
    vi.useFakeTimers();
    const list = vi
      .fn<MachineGateway["list"]>()
      .mockResolvedValueOnce([machine({ id: "a" })])
      .mockResolvedValueOnce([machine({ id: "unrelated", status: "online" })])
      .mockResolvedValueOnce([machine({ id: "pair-1", status: "offline" })]);
    const controller = new BotDeploymentController(
      gateway({ list, assignment: vi.fn(async () => null) }),
      "bot-1",
      { pollIntervalMs: 10 },
    );
    await controller.load();
    await controller.startPairing("workshop");
    expect(controller.getSnapshot().pairing?.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.getSnapshot().pairing?.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.getSnapshot().pairing?.phase).toBe("paired");
    controller.dispose();
  });

  it("expires pairings past the server deadline", async () => {
    vi.useFakeTimers();
    const controller = new BotDeploymentController(gateway(), "bot-1", { pollIntervalMs: 10 });
    await controller.startPairing("workshop");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(controller.getSnapshot().pairing?.phase).toBe("expired");
    controller.dispose();
  });

  it("stops polling after dispose", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => [machine({ id: "a" })]);
    const controller = new BotDeploymentController(gateway({ list }), "bot-1", {
      pollIntervalMs: 10,
    });
    await controller.load();
    await controller.startPairing("workshop");
    controller.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("cancels pairing and revokes machines through the gateway", async () => {
    const cancelPairing = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    const list = vi.fn(async () => [machine({ id: "a" })]);
    // Revoking credentials must not implicitly relocate the bot.
    const assignment = vi.fn<MachineGateway["assignment"]>().mockResolvedValue("a");
    const controller = new BotDeploymentController(
      gateway({ cancelPairing, revoke, list, assignment }),
      "bot-1",
    );
    await controller.load();
    await controller.startPairing("workshop");
    await controller.cancelPairing();
    expect(cancelPairing).toHaveBeenCalledWith("pair-1");
    expect(controller.getSnapshot().pairing).toBeNull();
    await controller.revoke("a");
    expect(revoke).toHaveBeenCalledWith("a");
    expect(controller.getSnapshot().botMachineId).toBe("a");
    controller.dispose();
  });
});
