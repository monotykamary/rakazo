import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ManagedResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
export type BrokerCall = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  context?: ExtensionContext,
) => Promise<ManagedResult>;
export const textResult = (text: string, details?: unknown): ManagedResult => ({
  content: [{ type: "text", text }],
  details,
});
export function resultValue(result: ManagedResult): Record<string, unknown> {
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { content: text };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { content: text };
  const record = value as Record<string, unknown>;
  if (record.error || record.isError === true)
    throw new Error("Authorized computer operation failed");
  return record;
}
export function createBrokerCall(proxies: ToolDefinition[], stopped: () => boolean): BrokerCall {
  const tools = new Map(proxies.map((tool) => [tool.name, tool]));
  return async (name, args, signal, context) => {
    if (stopped()) throw new Error("Managed execution is paused");
    signal?.throwIfAborted();
    const tool = tools.get(name);
    if (!tool) throw new Error(`Authorized capability unavailable: ${name}`);
    const prepared = tool.prepareArguments ? await tool.prepareArguments(args) : args;
    const result = await tool.execute(randomUUID(), prepared, signal, undefined, context!);
    if (result.terminate) throw new Error("Managed execution paused by authority broker");
    return result;
  };
}
const quote = (value: unknown) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const number = (value: unknown, fallback: number, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
const pathSchema = { path: Type.String() };
const optionalPath = { path: Type.Optional(Type.String()) };

/** Every computer effect crosses the broker. These definitions never instantiate SDK native tools. */
export function managedCoreTools(call: BrokerCall): ToolDefinition[] {
  type Execute = (
    id: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: Parameters<ToolDefinition["execute"]>[3],
    ctx: ExtensionContext,
  ) => Promise<ManagedResult>;
  const define = (
    name: string,
    properties: Record<string, ToolDefinition["parameters"]>,
    execute: Execute,
  ): ToolDefinition => ({
    name,
    label: name,
    description: `Authorized computer ${name}; no host filesystem access.`,
    parameters: Type.Object(properties),
    execute: (id, args, signal, update, ctx) =>
      execute(id, args as Record<string, unknown>, signal, update, ctx),
  });
  return [
    define(
      "read",
      { ...pathSchema, offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) },
      async (_id, args, signal, _update, ctx) => {
        const result = await call("read_file", { path: args.path }, signal, ctx);
        const value = resultValue(result);
        const text = typeof value.content === "string" ? value.content : JSON.stringify(value);
        const offset = number(args.offset, 1, Number.MAX_SAFE_INTEGER);
        const limit = number(args.limit, 2000, 2000);
        const lines = text.split("\n");
        const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
        const truncated = selected.length > 50000 || offset - 1 + limit < lines.length;
        return {
          ...result,
          content: [
            ...textResult(
              selected.slice(0, 50000) +
                (truncated ? `\n[Truncated; continue with offset=${offset + limit}]` : ""),
            ).content,
            ...result.content.filter((part) => part.type === "image"),
          ],
        };
      },
    ),
    define(
      "write",
      { ...pathSchema, content: Type.String() },
      async (_id, args, signal, _update, ctx) =>
        call("write_file", { path: args.path, content: args.content }, signal, ctx),
    ),
    define(
      "ls",
      { ...optionalPath, limit: Type.Optional(Type.Number()) },
      async (_id, args, signal, _update, ctx) => {
        const result = await call("list_files", { path: args.path ?? "." }, signal, ctx);
        const value = resultValue(result);
        if (!Array.isArray(value.entries)) return result;
        const limit = number(args.limit, 500, 500);
        return textResult(
          value.entries
            .slice(0, limit)
            .map(
              (entry: Record<string, unknown>) =>
                `${entry.path ?? entry.name}${entry.kind === "dir" || entry.type === "directory" ? "/" : ""}`,
            )
            .join("\n") + (value.entries.length > limit ? "\n[Truncated]" : ""),
          result.details,
        );
      },
    ),
    ...["bash", "powershell"].map((name) =>
      define(
        name,
        {
          command: Type.String(),
          cwd: Type.Optional(Type.String()),
          timeout: Type.Optional(Type.Number()),
        },
        async (_id, args, signal, _update, ctx) => {
          // PowerShell is launched on the authorized computer, never on the worker.
          const result = await call(
            "shell",
            {
              command:
                name === "powershell"
                  ? `pwsh -NoProfile -NonInteractive -Command ${quote(args.command)}`
                  : args.command,
              ...(args.cwd ? { cwd: args.cwd } : {}),
            },
            typeof args.timeout === "number"
              ? AbortSignal.any([
                  ...(signal ? [signal] : []),
                  AbortSignal.timeout(number(args.timeout, 1, 86400) * 1000),
                ])
              : signal,
            ctx,
          );
          const value = resultValue(result);
          if (typeof value.exitCode === "number" && value.exitCode !== 0)
            throw new Error(`Process exited with code ${value.exitCode}`);
          return result;
        },
      ),
    ),
    define(
      "find",
      { pattern: Type.String(), ...optionalPath, limit: Type.Optional(Type.Number()) },
      async (_id, args, signal, _update, ctx) => {
        const result = await call(
          "shell",
          {
            command: `rg --files --hidden -g ${quote(args.pattern)} -g '!.git/**' -- ${quote(args.path ?? ".")}`,
          },
          signal,
          ctx,
        );
        const value = resultValue(result);
        return textResult(
          String(value.stdout ?? value.output ?? value.content ?? "")
            .split("\n")
            .slice(0, number(args.limit, 1000, 1000))
            .join("\n")
            .slice(0, 50000),
          result.details,
        );
      },
    ),
    define(
      "grep",
      {
        pattern: Type.String(),
        ...optionalPath,
        glob: Type.Optional(Type.String()),
        ignoreCase: Type.Optional(Type.Boolean()),
        literal: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      },
      async (_id, args, signal, _update, ctx) => {
        const result = await call(
          "shell",
          {
            command: `rg -n --no-heading${args.ignoreCase ? " -i" : ""}${args.literal ? " -F" : ""}${args.glob ? ` -g ${quote(args.glob)}` : ""} -C ${number(args.context, 0, 20)} -- ${quote(args.pattern)} ${quote(args.path ?? ".")}`,
          },
          signal,
          ctx,
        );
        const value = resultValue(result);
        return textResult(
          String(value.stdout ?? value.output ?? value.content ?? "")
            .split("\n")
            .slice(0, number(args.limit, 100, 1000))
            .join("\n")
            .slice(0, 50000),
          result.details,
        );
      },
    ),
    define(
      "edit",
      {
        ...pathSchema,
        edits: Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
            all: Type.Optional(Type.Boolean()),
          }),
        ),
        all: Type.Optional(Type.Boolean()),
      },
      async (_id, args, signal, _update, ctx) => {
        const result = await call(
          "edit_file",
          {
            path: args.path,
            edits: args.edits,
            ...(args.all === undefined ? {} : { all: args.all }),
          },
          signal,
          ctx,
        );
        resultValue(result);
        return result;
      },
    ),
  ];
}
