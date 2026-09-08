import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelBridge } from "./pi-rpc-model-bridge.js";
import { RunAuthority } from "./pi-rpc-tool-bridge.js";
import type { JsonPeer } from "./pi-rpc-transport.js";

const { stream } = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("./model-routing-broker.js", () => ({
  ModelRoutingBroker: class {
    primary = { models: [], resolved: {} };
    stream = stream;
  },
}));
beforeEach(() => {
  stream.mockReset();
  stream.mockImplementation(async function* () {
    yield { type: "done", reason: "stop" };
  });
});
const request: AgentRunRequest = {
  runId: "run-test",
  botId: "bot-test",
  threadId: "thread-test",
  instructions: "Use Fabric.",
  prompt: "Probe",
  history: [],
  tools: [],
  model: { provider: "test", id: "offline" },
};
const fabric = {
  name: "fabric_exec",
  description: "Execute through Fabric",
  parameters: { type: "object", properties: {} },
};
function setup() {
  const authority = new RunAuthority(request, new AbortController().signal);
  const bridge = new ModelBridge(request, authority, vi.fn());
  const send = vi.fn(async () => undefined);
  return { bridge, peer: { send } as unknown as JsonPeer, send };
}

describe("managed provider-facing tool boundary", () => {
  it.each(["read", "read_file", "run_subagent", "recall_memory", "mcp_search_tools"])(
    "rejects standalone %s before routing or fallback",
    async (name) => {
      const { bridge, peer, send } = setup();
      await expect(
        bridge.stream(
          { streamId: name, context: { messages: [], tools: [{ ...fabric, name }] } },
          peer,
        ),
      ).rejects.toThrow("exclusively fabric_exec");
      expect(stream).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each([
    { tools: [fabric, fabric] },
    { tools: [fabric, { ...fabric, name: "bash" }] },
    { tools: null },
    { tools: "fabric_exec" },
  ])("rejects duplicate, mixed or malformed catalogs %j", async ({ tools }) => {
    const { bridge, peer } = setup();
    await expect(
      bridge.stream({ streamId: "invalid", context: { messages: [], tools } }, peer),
    ).rejects.toThrow("exclusively fabric_exec");
    expect(stream).not.toHaveBeenCalled();
  });
  it("accepts only Fabric repeatedly across independent model streams", async () => {
    const { bridge, peer, send } = setup();
    const context = { messages: [], tools: [fabric] };
    for (const streamId of ["root", "retry", "resumed", "child"])
      await expect(bridge.stream({ streamId, context }, peer)).resolves.toEqual({ complete: true });
    expect(stream).toHaveBeenCalledTimes(4);
    for (const [forwarded] of stream.mock.calls) expect(forwarded.tools).toEqual([fabric]);
    expect(send).toHaveBeenCalledTimes(4);
  });
  it.each([{ tools: undefined }, { tools: [] }])(
    "allows tool-free compaction %j",
    async ({ tools }) => {
      const { bridge, peer } = setup();
      await expect(
        bridge.stream({ streamId: "compact", context: { messages: [], tools } }, peer),
      ).resolves.toEqual({ complete: true });
      expect(stream).toHaveBeenCalledOnce();
    },
  );
});
