import {
  createExecutionStore,
  createQueueStore,
  type ExecutionClient,
  type QueueClient,
} from "@rakazo/core";

export function useExecution(client: ExecutionClient, runId: string) {
  const store = useMemo(() => createExecutionStore(client, runId), [client, runId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    void store.loadMore();
  }, [store]);
  return { ...state, loadMore: store.loadMore };
}

import { useEffect, useMemo, useSyncExternalStore } from "react";

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
