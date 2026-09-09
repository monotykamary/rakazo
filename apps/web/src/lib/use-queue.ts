import type { QueueOperation } from "@rakazo/contracts";
import {
  createExecutionStore,
  createQueueStore,
  type ExecutionClient,
  type QueueClient,
} from "@rakazo/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";

export type ComposerMode = "send" | "steer" | "followUp";
export type ComposerModifierState = Pick<
  KeyboardEvent | MouseEvent,
  "altKey" | "ctrlKey" | "metaKey"
>;

export function isMacPlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator === "undefined" ? "" : navigator.platform);
  return /Mac|iPhone|iPad|iPod/i.test(value);
}

export function composerModeFromModifiers(
  modifiers: ComposerModifierState,
  mac = isMacPlatform(),
): ComposerMode {
  if (modifiers.altKey) return "steer";
  if (modifiers.metaKey || (!mac && modifiers.ctrlKey)) return "followUp";
  return "send";
}

export function composerModeLabel(mode: ComposerMode): string {
  if (mode === "steer") return "Steer";
  if (mode === "followUp") return "Queue";
  return "Send";
}

export function queueComposerBlockReason(input: {
  hasMentions: boolean;
  hasReply: boolean;
  requiresExplicitBot: boolean;
  botId?: string;
}): "structured-context" | "target-required" | null {
  if (input.hasMentions || input.hasReply) return "structured-context";
  if (input.requiresExplicitBot && !input.botId) return "target-required";
  return null;
}

export async function enqueueQueueMessage(
  client: QueueClient,
  scope: { threadId: string; botId: string },
  input: { lane: Exclude<ComposerMode, "send">; text: string; artifactIds?: string[] },
): Promise<void> {
  const snapshot = await client.list(scope);
  const operation: QueueOperation = {
    type: "enqueue",
    lane: input.lane,
    text: input.text,
    artifactIds: input.artifactIds?.length ? input.artifactIds : undefined,
  };
  const reply = await client.mutate({
    ...scope,
    requestId: `composer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    expectedRevision: snapshot.revision,
    operation,
  });
  if (!reply.ok) throw new Error(reply.error ?? "Could not update queue");
}

export function useExecution(client: ExecutionClient, runId: string) {
  const store = useMemo(() => createExecutionStore(client, runId), [client, runId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    void store.loadMore();
  }, [store]);
  return { ...state, loadMore: store.loadMore };
}

export { createQueueStore, type QueueClient, queueRows } from "@rakazo/core";

export function useQueue(client: QueueClient, threadId: string, botId: string) {
  const store = useMemo(
    () => createQueueStore(client, { threadId, botId }),
    [client, threadId, botId],
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    void store.refresh();
    const timer = setInterval(() => void store.refresh(), 2000);
    return () => clearInterval(timer);
  }, [store]);
  return {
    ...state,
    mutate: store.mutate,
    steeringParticipants: store.steeringParticipants,
    steer: store.steer,
  };
}
