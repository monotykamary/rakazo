// Callback handles must never replace the execution kernel or native core tools.
export const MANAGED_RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "fabric_exec",
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
]);
