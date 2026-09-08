import { createServer } from "node:http";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";

it("gracefully suspends a background child waiting for model abort and retains its paused checkpoint", async () => {
  let opened!: () => void;
  const modelOpened = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let closed!: () => void;
  const modelClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Consume the offline model request. */
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    response.once("close", closed);
    opened();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing offline model listener");
  const harness = await createRpcHarness({
    runTimeoutMs: 60_000,
    tool: {
      name: "fabric_exec",
      args: {
        code: 'const child = await agents.spawn({task:"Background checkpoint marker"}); return child.id;',
      },
    },
  });
  let control: Parameters<NonNullable<AgentRunRequest["runtimeBoundary"]>>[1] | undefined;
  let saved: any;
  try {
    const work = harness.run({
      tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
      executeTool: async () => ({ ok: true }),
      resolveParticipantModel: async () => ({
        ...harness.request.model,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      }),
      runtimeBoundary: async (_boundary, current) => {
        control = current;
      },
      session: {
        save: async (state) => {
          saved = state;
        },
      },
    });
    void work.catch(() => undefined);
    await modelOpened;
    expect(control).toBeDefined();
    await control!.pause();
    await work;
    // Socket close is delivered asynchronously after the worker acknowledgment.
    await modelClosed;
    expect(saved.agents.records).toHaveLength(1);
    expect(saved.agents.records[0].record.status).toBe("paused");
    expect(JSON.stringify(saved.agents.records[0].record.checkpoint.session)).toContain(
      "Background checkpoint marker",
    );
    expect(harness.host.reaped).toBe(2);
  } finally {
    await harness.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 120000);
