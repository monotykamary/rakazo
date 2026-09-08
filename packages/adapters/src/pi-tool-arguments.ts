import { textContentArg } from "./tool-text.js";

/** Compatibility normalization before schema validation; never changes connector routes. */
export function prepareManagedToolArguments(name: string, value: unknown): Record<string, unknown> {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  switch (name) {
    case "destination.write":
      return {
        collection: String(raw.collection ?? "notes"),
        title: String(raw.title ?? "Rakazo result"),
        body: String(raw.body ?? ""),
      };
    case "remember":
      return { content: String(raw.content ?? ""), path: String(raw.path ?? "MEMORY.md") };
    case "request_takeover":
      return { reason: String(raw.reason ?? "I need you on the screen.") };
    case "ask_user":
      return {
        question: String(raw.question ?? "What should I use?"),
        options: Array.isArray(raw.options) ? raw.options.map(String) : raw.options,
      };
    case "write_file":
      return {
        path: String(raw.path ?? "notes/result.txt"),
        content: textContentArg(raw.content, ""),
      };
    case "computer_act":
      return {
        actions: Array.isArray(raw.actions) ? raw.actions : [],
        observe: raw.observe === undefined ? true : Boolean(raw.observe),
        settle_ms: Number(raw.settle_ms ?? 350),
      };
    case "list_files":
    case "read_file":
    case "open_path":
      return { path: String(raw.path ?? "") };
    case "launch_app":
      return { application: String(raw.application ?? ""), uri: String(raw.uri ?? "") };
    case "shell":
      return {
        command: String(raw.command ?? ""),
        ...(raw.cwd ? { cwd: String(raw.cwd) } : {}),
      };
    case "run_subagent":
      return {
        name: String(raw.name ?? "helper"),
        task: String(raw.task ?? ""),
        instructions: String(raw.instructions ?? ""),
        ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
        ...(raw.worktree === undefined ? {} : { worktree: raw.worktree }),
        ...(raw.worktreeId === undefined ? {} : { worktreeId: raw.worktreeId }),
        ...(raw.participantId === undefined ? {} : { participantId: raw.participantId }),
      };
    case "archive_bot":
    case "delete_bot":
      return {
        confirm_name: String(raw.confirm_name ?? raw.confirmName ?? ""),
        bot_id: String(raw.bot_id ?? raw.botId ?? ""),
      };
    default:
      return raw;
  }
}
