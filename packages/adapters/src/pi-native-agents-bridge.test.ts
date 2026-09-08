import {
  AgentService,
  createAgentServiceClient,
  createAgentServiceHandler,
} from "pi-fabric/agents";
import { expect, it } from "vitest";
import { AgentsBridge, createPrivateAgentsDispatcher } from "./pi-rpc-agents-bridge.js";
import type { PrivateDuplex } from "./pi-rpc-protocol.js";
import { AsyncChannel, JsonPeer } from "./pi-rpc-transport.js";

it("dispatches native agents over real private RPC without exposing host checkpoints or caller authority", async () => {
  const input = new AsyncChannel<Uint8Array>();
  const output = new AsyncChannel<Uint8Array>();
  const port = (
    incoming: AsyncChannel<Uint8Array>,
    outgoing: AsyncChannel<Uint8Array>,
  ): PrivateDuplex => ({
    incoming,
    write: async (frame) => outgoing.push(frame),
    close: async () => {
      incoming.close();
      outgoing.close();
    },
  });
  let preparedId: string | undefined;
  const service = new AgentService({
    rootId: "root",
    port: {
      prepare: async (request) => {
        preparedId = request.id;
        return { private: "binding" };
      },
      execute: async (request) => {
        expect(request.id).toBe(preparedId);
        await request.emit({ type: "checkpoint", checkpoint: { hiddenThinking: "host only" } });
        return {
          status: "completed",
          text: '{"answer":42}',
          checkpoint: { secretTranscript: "host only" },
        };
      },
    },
  });
  const bridge = new AgentsBridge(createAgentServiceHandler(service, "root"));
  const host = new JsonPeer(port(input, output), async (message) => {
    if (message.operation === "agents") return bridge.invoke(message.data);
    if (message.operation === "agents_cancel") {
      bridge.cancel(message.data);
      return {};
    }
    throw new Error("Unexpected operation");
  });
  const guest = new JsonPeer(port(output, input), async () => {
    throw new Error("Unexpected reverse request");
  });
  const client = createAgentServiceClient(createPrivateAgentsDispatcher(guest));
  try {
    const result = await client.run({
      task: "offline",
      schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
    });
    expect(result).toMatchObject({ status: "completed", value: { answer: 42 } });
    expect(result).not.toHaveProperty("checkpoint");
    expect(await client.status(result.id)).not.toHaveProperty("checkpoint");
    expect(await client.list()).toEqual([await client.status(result.id)]);
    expect(service.snapshot().records[0]!.record.checkpoint).toEqual({
      secretTranscript: "host only",
    });
    await expect(client.dispatch("run", { task: "escape", parentId: "other" })).rejects.toThrow();
    await expect(client.dispatch("spawn", { task: "escape", worktree: true })).rejects.toThrow();
    expect(service.snapshot().starts).toBe(1);
  } finally {
    bridge.close();
    await service.close();
    await Promise.all([host.close(), guest.close()]);
  }
});
