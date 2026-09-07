export const PI_RPC_VERSION = 1;
export const MAX_RPC_FRAME_BYTES = 16 * 1024 * 1024;

export interface PrivateDuplex {
  readonly incoming: AsyncIterable<Uint8Array>;
  write(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export interface AgentProcessScope {
  readonly runId: string;
  readonly threadId: string;
  readonly botId: string;
  readonly spaceId: string;
}
export interface AgentProcessConnection {
  rpc: PrivateDuplex;
  bridge: PrivateDuplex;
  stop(): Promise<void>;
}
/** The implementation must provide actual isolation, never a same-user child fallback. */
export interface AgentProcessHost {
  start(scope: Readonly<AgentProcessScope>, signal: AbortSignal): Promise<AgentProcessConnection>;
}
export const MEMORY_ACTIONS = ["recall", "expand", "sessions"] as const;
export type MemoryRpcAction = (typeof MEMORY_ACTIONS)[number];
export function memoryAction(value: unknown): MemoryRpcAction {
  if (typeof value !== "string" || !(MEMORY_ACTIONS as readonly string[]).includes(value))
    throw new Error("Unsupported memory action");
  return value as MemoryRpcAction;
}
export type JsonRecord = Record<string, unknown>;
export function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid managed RPC object");
  return value as JsonRecord;
}
export function string(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024)
    throw new Error("Invalid managed RPC identifier");
  return value;
}
