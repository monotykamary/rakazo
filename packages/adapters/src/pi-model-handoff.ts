import {
  type ModelSelection,
  type ModelSelectionStatus,
  sameModelSelection,
} from "@rakazo/contracts";
import { record } from "./pi-rpc-protocol.js";

export const MODEL_HANDOFF_ERROR =
  "Model change failed. The previous configuration is preserved. Retry to continue.";

/** A fresh fenced worker is idle; never invoke this from a tool/context hook. */
export async function applyManagedModelSelection(input: {
  requested: ModelSelection;
  previous: ModelSelection | null;
  thinkingLevel: NonNullable<ModelSelection["thinkingLevel"]>;
  established: boolean;
  modelId: string;
  rpc(command: string, data: Record<string, unknown>): Promise<unknown>;
  checkpoint(status: ModelSelectionStatus): Promise<void>;
}): Promise<void> {
  const status: ModelSelectionStatus = {
    requested: input.requested,
    effective: input.previous,
    status: "pending",
    error: null,
  };
  const nextEffective = { ...input.requested, thinkingLevel: input.thinkingLevel };
  const state = record(await input.rpc("get_state", {}));
  if (state.isStreaming || state.isCompacting || Number(state.pendingMessageCount ?? 0) > 0) {
    await input.checkpoint(status);
    throw new Error("Model change is pending until the participant is idle");
  }
  const unchanged =
    sameModelSelection(nextEffective, input.previous) &&
    record(state.model).id === input.modelId &&
    state.thinkingLevel === input.thinkingLevel;
  if (unchanged) {
    await input.checkpoint({ ...status, effective: nextEffective, status: "applied" });
    return;
  }
  await input.checkpoint(status);
  try {
    if (input.established) await input.rpc("compact", {});
    await input.rpc("set_model", { provider: "rakazo-broker", modelId: input.modelId });
    await input.rpc("set_thinking_level", { level: input.thinkingLevel });
    const effective = record(await input.rpc("get_state", {}));
    if (
      record(effective.model).id !== input.modelId ||
      effective.thinkingLevel !== input.thinkingLevel
    )
      throw new Error("Runtime did not confirm the requested model configuration");
    await input.checkpoint({ ...status, effective: nextEffective, status: "applied" });
  } catch {
    // No prompt has been accepted. The worker is discarded; only the old committed
    // configuration may be restored, including after a process crash between setters.
    await input.checkpoint({ ...status, status: "failed", error: MODEL_HANDOFF_ERROR });
    throw new Error(MODEL_HANDOFF_ERROR);
  }
}
