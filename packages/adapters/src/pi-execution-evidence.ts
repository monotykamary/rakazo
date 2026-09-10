import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { fabricNestedCalls, fabricNestedHeadline } from "@rakazo/core";

export function fabricNestedCallEvidence(details: unknown): {
  nestedCalls?: ReturnType<typeof fabricNestedCalls>;
} {
  const nestedCalls = fabricNestedCalls(details);
  return nestedCalls.length ? { nestedCalls } : {};
}

type ExecutionEvent = Extract<AgentRuntimeEvent, { type: "execution" }>;

export function nestedFabricExecutionEvents(
  parentExecutionId: string,
  participantId: string,
  nestedCalls: unknown,
  status: ExecutionEvent["status"],
): ExecutionEvent[] {
  const calls = fabricNestedCalls({ nestedCalls });
  if (!calls.length || status === "paused") return [];
  return calls.map((call, index) => ({
    type: "execution",
    executionId: `${parentExecutionId}:${call.ref}:${index}`,
    parentExecutionId,
    name: fabricNestedHeadline(call),
    participantId,
    status: call.success === false ? "failed" : status,
  }));
}

/** Keep whole strings or omit them: partial truncation could defeat later exact secret redaction. */
export function boundedExecutionEvidence(
  value: Record<string, unknown>,
  maxBytes = 65536,
): { value: Record<string, unknown>; truncated: boolean } {
  let remaining = maxBytes;
  let truncated = false;
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (input === undefined) return undefined;
    if (remaining <= 0 || depth > 12) {
      truncated = true;
      return null;
    }
    if (input === null || typeof input === "boolean" || typeof input === "number") {
      remaining -= 8;
      return input;
    }
    if (typeof input === "string") {
      const size = Buffer.byteLength(JSON.stringify(input));
      if (size > remaining) {
        truncated = true;
        return undefined;
      }
      remaining -= size;
      return input;
    }
    if (typeof input !== "object" || seen.has(input)) {
      truncated = true;
      return undefined;
    }
    seen.add(input);
    if (Array.isArray(input)) {
      if (input.length > 128) truncated = true;
      return input.slice(0, 128).map((item) => visit(item, depth + 1));
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      remaining -= Buffer.byteLength(JSON.stringify(key)) + 4;
      if (remaining < 0) {
        truncated = true;
        break;
      }
      output[key] = visit(item, depth + 1);
    }
    return output;
  };
  const output = visit(value, 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) return { value: {}, truncated: true };
  return { value: output, truncated };
}
