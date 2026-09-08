import { describe, expect, it, vi } from "vitest";
import { AgentsBridge, createPrivateAgentsDispatcher } from "./pi-rpc-agents-bridge.js";
import type { JsonPeer } from "./pi-rpc-transport.js";

describe("private native agents dispatcher", () => {
  it("passes only native arguments to a caller-bound dispatcher and rejects replay", async () => {
    const dispatch = vi.fn(async () => ({ id: "child", status: "completed" }));
    const bridge = new AgentsBridge(dispatch);
    const input = { callId: "one", action: "run", args: { task: "offline" } };
    expect(await bridge.invoke(input)).toEqual({ id: "child", status: "completed" });
    expect(dispatch).toHaveBeenCalledWith("run", { task: "offline" }, expect.any(AbortSignal));
    await expect(bridge.invoke(input)).rejects.toThrow("replayed");
    await expect(bridge.invoke({ ...input, callId: "two", callerId: "foreign" })).rejects.toThrow(
      "Invalid",
    );
    await expect(bridge.invoke({ ...input, callId: "three", action: "create" })).rejects.toThrow(
      "Unsupported",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("cancels only the addressed waiter and keeps the other invocation live", async () => {
    const signals: AbortSignal[] = [];
    const bridge = new AgentsBridge(async (_action, _args, signal) => {
      signals.push(signal!);
      return new Promise((resolve) =>
        signal!.addEventListener("abort", () => resolve("cancelled"), { once: true }),
      );
    });
    const one = bridge.invoke({ callId: "one", action: "wait", args: { id: "child" } });
    const two = bridge.invoke({ callId: "two", action: "wait", args: { id: "child" } });
    bridge.cancel({ callId: "one" });
    expect(await one).toBe("cancelled");
    expect(signals[1]!.aborted).toBe(false);
    bridge.close();
    expect(await two).toBe("cancelled");
  });

  it("retains response correlation across cancellation and never retries indeterminate failures", async () => {
    let settle!: (value: unknown) => void;
    const request = vi.fn(async (operation: string) =>
      operation === "agents"
        ? new Promise((resolve) => {
            settle = resolve;
          })
        : {},
    );
    const dispatch = createPrivateAgentsDispatcher({ request } as unknown as JsonPeer);
    const controller = new AbortController();
    const waiting = dispatch("wait", { id: "child" }, controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    expect(request.mock.calls.map(([operation]) => operation)).toEqual(["agents", "agents_cancel"]);
    settle({ status: "completed" });
    await rejected;
    request.mockRejectedValueOnce(new Error("disconnected"));
    await expect(dispatch("spawn", { task: "offline" })).rejects.toThrow("disconnected");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
