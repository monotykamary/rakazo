import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMcpProvider, type HostedMcpSource } from "pi-fabric/mcp";
import type { FabricProvider } from "pi-fabric/protocol";

export type ManagedProxyTool = ToolDefinition & {
  connector?: { id: string; resourceId?: string; toolName: string };
};

/** Maps trusted backend catalog identities; no model-supplied connection material. */
export function createManagedMcpProvider(options: {
  tools: readonly ManagedProxyTool[];
  execute(
    tool: ManagedProxyTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}): FabricProvider {
  const servers = new Map<string, Map<string, ManagedProxyTool>>();
  for (const tool of options.tools) {
    if (tool.connector?.id !== "mcp") continue;
    const { resourceId, toolName } = tool.connector;
    if (!resourceId || !toolName)
      throw new Error("MCP tools require an authorized resource and tool identity");
    // UTF-16 code units are injective even for malformed Unicode; identifiers contain no dots.
    const server = `s_${Array.from({ length: resourceId.length }, (_, i) =>
      resourceId.charCodeAt(i).toString(16).padStart(4, "0"),
    ).join("")}`;
    const tools = servers.get(server) ?? new Map<string, ManagedProxyTool>();
    if (tools.has(toolName)) throw new Error("Duplicate authorized MCP tool identity");
    tools.set(toolName, tool);
    servers.set(server, tools);
  }
  const source: HostedMcpSource = {
    listServers: () => [...servers.keys()],
    async listTools(server) {
      const tools = servers.get(server);
      if (!tools) throw new Error("Unknown authorized MCP source");
      return [...tools].map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.parameters as unknown as Record<string, unknown>,
      }));
    },
    async callTool(server, name, { args, signal }) {
      if (signal?.aborted) throw new Error("MCP call cancelled");
      const tool = servers.get(server)?.get(name);
      if (!tool) throw new Error("Unknown authorized MCP tool");
      // The broker rechecks current authority and retains approval, budget, and replay policy.
      return options.execute(tool, args, signal);
    },
  };
  return createMcpProvider({ source });
}
