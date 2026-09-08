import type { ConnectorRoute } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { bindPlacementExecutor } from "./pi-placement.js";

describe("participant placement and cancellation", () => {
  it.each([
    { name: "read_file", args: { path: "file.txt" }, expected: { path: "project/file.txt" } },
    {
      name: "shell",
      args: { command: "true", cwd: "sub" },
      expected: { command: "true", cwd: "project/sub" },
    },
    { name: "message_user", args: { text: "progress" }, expected: { text: "progress" } },
  ])("preserves scoped cancellation for $name", async ({ name, args, expected }) => {
    const execute = vi.fn(async () => "done");
    const signal = new AbortController().signal;
    await bindPlacementExecutor("project", execute)(name, args, "call", undefined, signal);
    expect(execute).toHaveBeenCalledWith(name, expected, "call", undefined, signal);
  });

  it("does not rewrite connector arguments or lose their private route and signal", async () => {
    const execute = vi.fn(async () => "done");
    const signal = new AbortController().signal;
    const route: ConnectorRoute = {
      connectorId: "installed",
      resourceId: "source",
      toolName: "lookup",
    };
    const args = { path: "/remote/resource" };
    await bindPlacementExecutor("project", execute)("lookup", args, "call", route, signal);
    expect(execute).toHaveBeenCalledWith("lookup", args, "call", route, signal);
  });
});
