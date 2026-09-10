const FABRIC_EXEC = "fabric_exec";
const HEADLINE_KEYS = ["path", "pattern", "command", "query", "url", "name"] as const;

export type FabricNestedCall = {
  ref: string;
  name: string;
  tool?: string;
  provider?: string;
  args?: Record<string, unknown>;
  success?: boolean;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/** Same coercion Pi Fabric uses for fabric_exec `display`. */
export function normalizeFabricDisplay(
  input: unknown,
): { name?: string; description?: string } | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return normalizeFabricDisplay(parsed) ?? { name: trimmed };
        }
      } catch {
        /* keep the raw string as the name */
      }
    }
    return { name: trimmed };
  }
  const display = record(input);
  const name = text(display.name);
  const description = text(display.description);
  if (!name && !description) return undefined;
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

function headlineArgs(value: unknown): Record<string, unknown> | undefined {
  const args = record(value);
  const picked: Record<string, unknown> = {};
  for (const key of HEADLINE_KEYS) {
    const item = text(args[key]);
    if (item) picked[key] = item;
  }
  return Object.keys(picked).length ? picked : undefined;
}

function nestedCall(value: unknown): FabricNestedCall | undefined {
  const item = record(value);
  const ref = text(item.ref) ?? text(item.tool) ?? text(item.action) ?? text(item.name);
  if (!ref) return undefined;
  const provider = text(item.provider);
  const tool = text(item.tool) ?? text(item.action);
  const success =
    typeof item.success === "boolean"
      ? item.success
      : item.outcome === "succeeded"
        ? true
        : item.outcome === "failed" || item.outcome === "aborted" || item.outcome === "timed_out"
          ? false
          : undefined;
  const args = headlineArgs(item.args);
  const name = [provider, tool].filter(Boolean).join(".") || ref;
  return {
    ref,
    name,
    ...(tool ? { tool } : {}),
    ...(provider ? { provider } : {}),
    ...(args ? { args } : {}),
    ...(success !== undefined ? { success } : {}),
  };
}

function fromList(value: unknown): FabricNestedCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const call = nestedCall(item);
    return call ? [call] : [];
  });
}

/** Nested tools from TypeScript audits/operations or Python trace.calls. */
export function fabricNestedCalls(details: unknown): FabricNestedCall[] {
  const payload = record(details);
  const nested = fromList(payload.nestedCalls);
  if (nested.length) return nested;
  const audits = fromList(payload.audits);
  if (audits.length) return audits;
  const trace = record(payload.trace);
  const operations = fromList(trace.operations);
  if (operations.length) return operations;
  return fromList(trace.calls);
}

export function fabricNestedHeadline(call: FabricNestedCall): string {
  const args = call.args ?? {};
  const detail = HEADLINE_KEYS.map((key) => text(args[key])).find(Boolean);
  return detail ? `${call.name} ${detail}` : call.name;
}

export function fabricDisplayFromPayload(
  payload: Record<string, unknown>,
): { name?: string; description?: string } | undefined {
  return (
    normalizeFabricDisplay(payload.display) ??
    normalizeFabricDisplay(record(payload.input).display) ??
    normalizeFabricDisplay(record(payload.args).display)
  );
}

/** Compact label for a fabric_exec row; undefined for every other tool. */
export function fabricExecutionLabel(payload: Record<string, unknown>): string | undefined {
  const toolName = text(payload.name) ?? text(payload.toolName);
  if (toolName !== FABRIC_EXEC) return undefined;
  const display = fabricDisplayFromPayload(payload);
  if (display?.name) return display.name;
  if (display?.description) return display.description;
  return "Fabric program";
}
