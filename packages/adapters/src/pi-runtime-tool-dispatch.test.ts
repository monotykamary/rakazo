import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBotWorkspaceCwd, teamBotWorkspaceDirectory } from "./computer-support.js";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";
import { maxToolCallsPerTurn, normalizeAgentToolNames } from "./pi-runtime.js";
import { MANAGED_RESERVED_TOOL_NAMES } from "./pi-tool-names.js";

const destination: ConnectorTool = {
  name: "destination.write",
  description: "Write destination",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
  },
  route: { connectorId: "destination", toolName: "destination.write" },
};
const shell: ConnectorTool = {
  name: "shell",
  description: "Shell",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
};
function setup(tools: ConnectorTool[]) {
  const events: AgentRuntimeEvent[] = [];
  const executeTool = vi.fn(async () => ({ ok: true }));
  const request: AgentRunRequest = {
    runId: "run",
    botId: "bot",
    threadId: "thread",
    prompt: "test",
    instructions: "test",
    history: [],
    tools,
    model: { provider: "test", id: "test" },
    executeTool,
  };
  const authority = new RunAuthority(request, new AbortController().signal);
  const bridge = new ToolBridge(request, authority, (event) => events.push(event));
  return { request, authority, bridge, executeTool, events };
}
afterEach(() => vi.unstubAllEnvs());
describe("Pi connector tool dispatch", () => {
  it.each([...MANAGED_RESERVED_TOOL_NAMES])(
    "isolates reserved connector name %s while retaining its route",
    async (name) => {
      const tool = { ...destination, name };
      const fixture = setup([tool]);
      const exposed = fixture.bridge.catalog[0]!;
      expect(MANAGED_RESERVED_TOOL_NAMES.has(exposed.name)).toBe(false);
      expect(exposed.name).not.toBe(name);
      await fixture.bridge.invoke({ handle: exposed.handle, callId: "reserved", args: {} });
      expect(fixture.executeTool).toHaveBeenCalledWith(
        name,
        {},
        expect.any(String),
        destination.route,
        expect.any(AbortSignal),
      );
    },
  );
  it("keeps the real Fabric kernel active when a connector is named fabric_exec", async () => {
    const tool = { ...destination, name: "fabric_exec" };
    const name = normalizeAgentToolNames([tool])[0]!;
    const executeTool = vi.fn(async () => "connector result");
    const harness = await createRpcHarness({
      tool: {
        name: "fabric_exec",
        args: {
          code: `return await tools.call({ref:${JSON.stringify(`extensions.${name}`)},args:{collection:"notes",title:"Result",body:"Done"}});`,
        },
      },
    });
    try {
      await harness.run({ tools: [tool], executeTool });
      expect(executeTool).toHaveBeenCalledOnce();
      expect(executeTool).toHaveBeenCalledWith(
        "fabric_exec",
        { collection: "notes", title: "Result", body: "Done" },
        expect.any(String),
        destination.route,
        expect.any(AbortSignal),
      );
      for (const request of harness.requests)
        expect(
          request.tools.map((item: { function: { name: string } }) => item.function.name),
        ).toEqual(["fabric_exec"]);
    } finally {
      await harness.close();
    }
  }, 30000);
  it("keeps existing safe names stable when a reserved-name suffix collides", () => {
    const reserved = { ...destination, name: "fabric_exec" };
    const suffix = normalizeAgentToolNames([reserved])[0]!;
    const names = normalizeAgentToolNames([reserved, { ...destination, name: suffix }]);
    expect(names[1]).toBe(suffix);
    expect(new Set(names).size).toBe(2);
    expect(names).not.toContain("fabric_exec");
  });
  it("exposes safe names while freezing the original connector name and route", async () => {
    const fixture = setup([destination]);
    expect(fixture.bridge.catalog[0]?.name).toBe("destination_write");
    fixture.request.tools[0]!.route = { connectorId: "forged", toolName: "forged" };
    await fixture.bridge.invoke({
      handle: fixture.bridge.catalog[0]!.handle,
      callId: "one",
      args: { collection: "notes", title: "Result", body: "Done" },
      route: { connectorId: "forged" },
    });
    expect(fixture.executeTool).toHaveBeenCalledWith(
      "destination.write",
      { collection: "notes", title: "Result", body: "Done" },
      expect.stringContaining("run:"),
      { connectorId: "destination", toolName: "destination.write" },
      expect.any(AbortSignal),
    );
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ type: "execution", status: "completed" }),
    );
  });
  it("projects MCP provenance without rebinding installed authority or colliding source identities", async () => {
    const definition = (name: string, connectorId: string, protocol?: "mcp"): ConnectorTool => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      protocol,
      route: { connectorId, resourceId: "same-id", toolName: "lookup" },
    });
    const fixture = setup([
      definition("installed_lookup", "installed", "mcp"),
      definition("mcp_lookup", "mcp"),
      definition("api_lookup", "installed"),
    ]);
    expect(fixture.bridge.catalog.map((tool) => tool.connector)).toEqual([
      { id: "mcp", resourceId: "installed:same-id", toolName: "lookup" },
      { id: "mcp", resourceId: "mcp:same-id", toolName: "lookup" },
      { id: "installed", resourceId: "same-id", toolName: "lookup" },
    ]);
    await fixture.bridge.invoke({
      handle: fixture.bridge.catalog[0]!.handle,
      callId: "mcp-call",
      args: {},
    });
    expect(fixture.executeTool).toHaveBeenCalledWith(
      "installed_lookup",
      {},
      expect.any(String),
      { connectorId: "installed", resourceId: "same-id", toolName: "lookup" },
      expect.any(AbortSignal),
    );
  });
  it.each([undefined, "", "projects/demo"])(
    "preserves executor shell cwd ownership for %s",
    async (cwd) => {
      const fixture = setup([
        {
          ...shell,
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" }, cwd: { type: "string" } },
          },
        },
      ]);
      await fixture.bridge.invoke({
        handle: fixture.bridge.catalog[0]!.handle,
        callId: "cwd",
        args: { command: "pwd", ...(cwd === undefined ? {} : { cwd }) },
      });
      expect(fixture.executeTool).toHaveBeenCalledWith(
        "shell",
        { command: "pwd", ...(cwd ? { cwd } : {}) },
        expect.any(String),
        undefined,
        expect.any(AbortSignal),
      );
    },
  );

  it("lets the executor choose the Team bot directory through real native Pi bash", async () => {
    let resolvedCwd: string | undefined;
    const executeTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      resolvedCwd = resolveBotWorkspaceCwd("team", "bot", args.cwd as string | undefined);
      return { stdout: resolvedCwd, exitCode: 0 };
    });
    const harness = await createRpcHarness({ tool: { name: "shell", args: { command: "pwd" } } });
    try {
      await harness.run({ tools: [shell], executeTool });
      expect(executeTool).toHaveBeenCalledOnce();
      expect(resolvedCwd).toBe(teamBotWorkspaceDirectory("bot"));
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown handles and duplicate execution identities without replay", async () => {
    const { bridge, executeTool } = setup([shell]);
    const call = { handle: bridge.catalog[0]!.handle, callId: "same", args: { command: "true" } };
    await bridge.invoke(call);
    await expect(bridge.invoke(call)).rejects.toThrow("replayed");
    await expect(bridge.invoke({ ...call, handle: "forged", callId: "other" })).rejects.toThrow(
      "handle",
    );
    expect(executeTool).toHaveBeenCalledOnce();
  });
  it("serializes object file content rather than writing object Object", async () => {
    const { bridge, executeTool } = setup([
      {
        name: "write_file",
        description: "Write",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
      },
    ]);
    await bridge.invoke({
      handle: bridge.catalog[0]!.handle,
      callId: "one",
      args: { path: "state.json", content: { last_run: 1 } },
    });
    expect(executeTool).toHaveBeenCalledWith(
      "write_file",
      { path: "state.json", content: '{\n  "last_run": 1\n}' },
      expect.any(String),
      undefined,
      expect.any(AbortSignal),
    );
  });
  it("allows more than eighty calls by default and enforces a shared child fuse", async () => {
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "0");
    const fixture = setup([shell]);
    for (let index = 0; index < 100; index++)
      await fixture.bridge.invoke({
        handle: fixture.bridge.catalog[0]!.handle,
        callId: `call-${index}`,
        args: { command: "true" },
      });
    expect(fixture.executeTool).toHaveBeenCalledTimes(100);
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "2");
    const limited = setup([shell]);
    const child = new ToolBridge(limited.request, limited.authority, () => undefined);
    await limited.bridge.invoke({
      handle: limited.bridge.catalog[0]!.handle,
      callId: "parent",
      args: { command: "true" },
    });
    await child.invoke({
      handle: child.catalog[0]!.handle,
      callId: "child",
      args: { command: "true" },
    });
    await expect(
      child.invoke({
        handle: child.catalog[0]!.handle,
        callId: "excess",
        args: { command: "true" },
      }),
    ).rejects.toThrow("budget");
    expect(limited.executeTool).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, "", "0", "-5", "abc"])("treats %s fuse as unlimited", (value) => {
    expect(maxToolCallsPerTurn(value === undefined ? {} : { MAX_TOOL_CALLS_PER_TURN: value })).toBe(
      0,
    );
  });
  it("normalizes a positive fuse", () => {
    expect(maxToolCallsPerTurn({ MAX_TOOL_CALLS_PER_TURN: " 12.9 " })).toBe(12);
  });
  it.each([
    { allowSilentEmpty: true, expected: undefined },
    { allowSilentEmpty: false, expected: "No response. Try again." },
    { emptyResponseText: "Peer update", expected: "Peer update" },
    { emptyResponseText: "  ", expected: "No response. Try again." },
  ])(
    "preserves intentional empty-turn behavior %#",
    async ({ expected, ...overrides }) => {
      const harness = await createRpcHarness({ empty: true });
      try {
        const events = await harness.run(overrides);
        expect(events.at(-1)).toEqual(
          expected ? { type: "done", text: expected } : { type: "done" },
        );
      } finally {
        await harness.close();
      }
    },
    30000,
  );
  it("awaits durable steering at the actual next model boundary", async () => {
    const harness = await createRpcHarness({
      tool: { name: "read_file", args: { path: "notes.txt" } },
    });
    let count = 0;
    const claimSteering = vi.fn(async (seen: string[]) => {
      count++;
      return count === 3 && !seen.includes("steering")
        ? [{ id: "steering", messageId: "steering-message", text: "Boundary marker" }]
        : [];
    });
    try {
      await harness.run({
        tools: [
          {
            name: "read_file",
            description: "Read",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        executeTool: async () => "content",
        claimSteering,
      });
      expect(JSON.stringify(harness.requests[0])).not.toContain("Boundary marker");
      expect(JSON.stringify(harness.requests[1])).toContain("Boundary marker");
      expect(claimSteering).toHaveBeenCalledTimes(3);
    } finally {
      await harness.close();
    }
  }, 30000);
  it("delegates using a second real full SDK process and shared backend model", async () => {
    const harness = await createRpcHarness({
      tool: { name: "run_subagent", args: { name: "helper", task: "Help" } },
    });
    try {
      const events = await harness.run({
        executeTool: async () => ({ ok: true }),
        tools: [
          {
            name: "run_subagent",
            description: "Delegate",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" }, task: { type: "string" } },
            },
          },
        ],
      });
      expect(harness.host.starts).toBe(2);
      expect(harness.host.reaped).toBe(2);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "subagent",
          status: "completed",
          result: "Offline answer.",
        }),
      );
      expect(events.filter((event) => event.type === "usage")).toHaveLength(3);
    } finally {
      await harness.close();
    }
  }, 30000);
});
