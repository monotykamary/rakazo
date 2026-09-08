import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createManagedMcpProvider, type ManagedProxyTool } from "./pi-managed-mcp.js";

const context = {
  cwd: "",
  signal: new AbortController().signal,
  parentToolCallId: "parent",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
};
const tool = (resourceId: string, toolName: string): ManagedProxyTool => ({
  name: `broker_${resourceId}_${toolName}`,
  label: toolName,
  description: "Authorized tool",
  parameters: Type.Object({ value: Type.String() }),
  connector: { id: "mcp", resourceId, toolName },
  execute: async () => {
    throw new Error("Must use the approved broker callback");
  },
});

describe("managed native MCP", () => {
  it("advertises only MCP routes and calls the original broker tool with raw schema", async () => {
    const tools = Array.from({ length: 30 }, (_, i) => tool("resource", `read-${i}`));
    const other = {
      ...tool("api", "other"),
      connector: { id: "installed", resourceId: "api", toolName: "other" },
    };
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "broker result" }] }));
    const provider = createManagedMcpProvider({ tools: [...tools, other], execute });
    const listed = await provider.list({}, context);
    expect(provider.name).toBe("mcp");
    expect(listed).toHaveLength(30);
    const selected = listed[29]!;
    expect(selected.inputSchema).toEqual(tools[29]!.parameters);
    expect(selected.name).toMatch(/^s_[0-9a-f]+\.read-29$/);
    await expect(provider.invoke(selected.name, { value: "ok" }, context)).resolves.toMatchObject({
      text: "broker result",
    });
    expect(execute).toHaveBeenCalledWith(tools[29], { value: "ok" }, context.signal);
    expect(listed.some((item) => item.name.startsWith("$"))).toBe(false);
  });

  it("keeps collision-prone resources distinct and refuses duplicate or absent authority", async () => {
    const execute = vi.fn(async () => null);
    const provider = createManagedMcpProvider({
      tools: [tool("a-b", "read"), tool("a.b", "read")],
      execute,
    });
    const listed = await provider.list({}, context);
    expect(new Set(listed.map((item) => item.namespace)).size).toBe(2);
    expect(() =>
      createManagedMcpProvider({ tools: [tool("a", "read"), tool("a", "read")], execute }),
    ).toThrow("Duplicate");
    expect(() => createManagedMcpProvider({ tools: [tool("", "read")], execute })).toThrow(
      "authorized resource",
    );
    await expect(provider.invoke("unknown.read", {}, context)).rejects.toThrow(
      "Unknown MCP server",
    );
    await expect(provider.invoke("$register", {}, context)).rejects.toThrow("management");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not turn discovery into approval and preserves broker rejection and abort", async () => {
    let allowed = true;
    const execute = vi.fn(async () => {
      if (!allowed) throw new Error("revoked by backend");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const provider = createManagedMcpProvider({ tools: [tool("a", "read")], execute });
    const [selected] = await provider.list({}, context);
    await provider.invoke(selected!.name, { value: "ok" }, context);
    allowed = false;
    await expect(provider.invoke(selected!.name, {}, context)).rejects.toThrow(
      "revoked by backend",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.invoke(selected!.name, {}, { ...context, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
