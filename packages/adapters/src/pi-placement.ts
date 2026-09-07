import { posix } from "node:path";
import type { AgentRunRequest } from "@rakazo/adapter-kit";

/** Logical computer paths only. This never reads or resolves the backend/worker filesystem. */
export function authorizedRelativePlacement(value: string): string {
  if (
    !value ||
    value.length > 4096 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").includes("..")
  )
    throw new Error("Placement must be an authorized workspace-relative path");
  return posix.normalize(value);
}
export function bindPlacementExecutor(
  cwd: string,
  execute: NonNullable<AgentRunRequest["executeTool"]>,
): NonNullable<AgentRunRequest["executeTool"]> {
  const root = authorizedRelativePlacement(cwd);
  const path = (value: unknown) => {
    const input = String(value ?? ".");
    if (
      input.startsWith("/") ||
      /^[A-Za-z]:/.test(input) ||
      input.includes("\\") ||
      input.split("/").includes("..")
    )
      throw new Error("Tool path escapes its captured placement");
    return posix.join(root, input);
  };
  return (name, args, executionId, route) => {
    if (route) return execute(name, args, executionId, route);
    if (
      ["read_file", "write_file", "edit_file", "list_files", "open_path", "attach_file"].includes(
        name,
      )
    )
      return execute(name, { ...args, path: path(args.path) }, executionId);
    if (name === "shell")
      return execute(
        name,
        { ...args, cwd: path(args.cwd === "/home/rakazo" ? "." : args.cwd) },
        executionId,
      );
    return execute(name, args, executionId, route);
  };
}
