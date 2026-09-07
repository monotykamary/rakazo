import type { ModelSelection, ModelSelectionStatus } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { applyManagedModelSelection, MODEL_HANDOFF_ERROR } from "./pi-model-handoff.js";

const old: ModelSelection = { provider: "provider", modelId: "old", thinkingLevel: "low" };
const next: ModelSelection = { provider: "provider", modelId: "new", thinkingLevel: "high" };
function fixture(
  options: {
    busy?: boolean;
    compacting?: boolean;
    pending?: number;
    runtimeModelId?: string;
    fail?: string;
    selection?: ModelSelection;
    previous?: ModelSelection | null;
    established?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const saves: ModelSelectionStatus[] = [];
  const requested = options.selection ?? next;
  const run = () =>
    applyManagedModelSelection({
      requested,
      previous: options.previous === undefined ? old : options.previous,
      thinkingLevel: requested.thinkingLevel ?? "medium",
      established: options.established ?? true,
      modelId: requested.modelId,
      rpc: async (command) => {
        calls.push(command);
        if (command === options.fail) throw new Error("secret must not escape");
        return {
          isStreaming: options.busy,
          isCompacting: options.compacting,
          pendingMessageCount: options.pending,
          model: {
            id:
              calls.length === 1
                ? (options.runtimeModelId ?? requested.modelId)
                : requested.modelId,
          },
          thinkingLevel: requested.thinkingLevel ?? "medium",
        };
      },
      checkpoint: async (status) => {
        saves.push(status);
      },
    });
  return { calls, saves, run };
}

describe("managed model handoff ordering", () => {
  it("compacts, sets model and effort, confirms and checkpoints before inference", async () => {
    const f = fixture();
    await f.run();
    expect(f.calls).toEqual([
      "get_state",
      "compact",
      "set_model",
      "set_thinking_level",
      "get_state",
    ]);
    expect(f.saves[0]).toMatchObject({ effective: old, status: "pending" });
    expect(f.saves.at(-1)).toMatchObject({ effective: next, status: "applied" });
  });
  it("compacts for reasoning-only changes too", async () => {
    const f = fixture({ selection: { ...old, thinkingLevel: "high" } });
    await f.run();
    expect(f.calls[1]).toBe("compact");
  });
  it("does not compact or set an unchanged effective selection", async () => {
    const f = fixture({ selection: old });
    await f.run();
    expect(f.calls).toEqual(["get_state"]);
  });
  it("does not compact when default effort resolves to the already effective level", async () => {
    const f = fixture({
      selection: { ...old, thinkingLevel: null },
      previous: { ...old, thinkingLevel: "medium" },
    });
    await f.run();
    expect(f.calls).toEqual(["get_state"]);
    expect(f.saves.at(-1)).toMatchObject({
      requested: { thinkingLevel: null },
      effective: { thinkingLevel: "medium" },
      status: "applied",
    });
  });
  it("does not compact a new empty session", async () => {
    const f = fixture({ previous: null, established: false });
    await f.run();
    expect(f.calls).not.toContain("compact");
  });
  it("preserves old effective state while busy without compacting or setting", async () => {
    const f = fixture({ busy: true });
    await expect(f.run()).rejects.toThrow("pending");
    expect(f.calls).toEqual(["get_state"]);
    expect(f.saves.at(-1)).toEqual({
      requested: next,
      effective: old,
      status: "pending",
      error: null,
    });
  });
  it.each([{ compacting: true }, { pending: 1 }])(
    "waits for compaction and queued messages before mutation: %j",
    async (options) => {
      const f = fixture(options);
      await expect(f.run()).rejects.toThrow("pending");
      expect(f.calls).toEqual(["get_state"]);
      expect(f.saves.at(-1)?.effective).toEqual(old);
    },
  );
  it("does not claim a no-op from saved metadata when SDK restore disagrees", async () => {
    const f = fixture({ selection: old, runtimeModelId: "unexpected-restored-model" });
    await f.run();
    expect(f.calls).toEqual([
      "get_state",
      "compact",
      "set_model",
      "set_thinking_level",
      "get_state",
    ]);
    expect(f.saves.at(-1)).toMatchObject({ effective: old, status: "applied" });
  });
  it.each(["compact", "set_model", "set_thinking_level"])(
    "keeps failed %s retryable with old effective configuration",
    async (fail) => {
      const f = fixture({ fail });
      await expect(f.run()).rejects.toThrow(MODEL_HANDOFF_ERROR);
      expect(f.saves.at(-1)).toEqual({
        requested: next,
        effective: old,
        status: "failed",
        error: MODEL_HANDOFF_ERROR,
      });
      expect(f.calls.at(-1)).toBe(fail);
      expect(JSON.stringify(f.saves)).not.toContain("secret");
    },
  );
});
