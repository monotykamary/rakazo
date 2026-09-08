import { createServer } from "node:http";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { createTestProcessHost } from "./pi-rpc-test-host.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";
import { AsyncChannel, readJsonFrames } from "./pi-rpc-transport.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function emulator(options: { quiet?: boolean; toolArgs?: Record<string, unknown> } = {}) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    if (options.quiet) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    const messages = input.messages as Array<{ role: string }>;
    const resultSeen = messages.some((message) => message.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta: unknown, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "chat-offline", object: "chat.completion.chunk", created: 1, model: "offline-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (!resultSeen && input.tools?.length) {
      frame({ role: "assistant", content: "Checking. " });
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call-read",
            type: "function",
            function: {
              name: input.tools[0].function.name,
              arguments: JSON.stringify({
                code: `return await pi.read(${JSON.stringify(options.toolArgs ?? { path: "notes.txt" })});`,
              }),
            },
          },
        ],
      });
      frame({}, "tool_calls");
    } else {
      frame({ role: "assistant", content: "The bridged result is ready." });
      frame({}, "stop");
    }
    res.write(
      `data: ${JSON.stringify({ id: "chat-offline", choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Emulator unavailable");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}
function request(baseUrl: string): AgentRunRequest {
  return {
    botId: "test-bot",
    threadId: "test-thread",
    runId: "test-run",
    sourceMessageId: "message-one",
    prompt: "Read notes",
    instructions: "Use the authorized read tool, then answer.",
    history: [],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    model: {
      provider: "openai-compatible",
      id: "offline-model",
      baseUrl,
      apiKey: "fake-backend-only-key",
    },
  };
}

describe("managed Pi RPC", () => {
  it("fails closed without an isolated host", async () => {
    const events = new PiAgentRuntime().run(request("http://unused.invalid"));
    await expect(events.next()).rejects.toThrow("isolated");
  });
  it("runs the real SDK RPC worker through the HTTP model broker and reverse tool bridge", async () => {
    const model = await emulator();
    const host = createTestProcessHost();
    const runtime = new PiAgentRuntime({ host });
    const input = request(model.baseUrl);
    const calls: unknown[] = [];
    const saves: unknown[] = [];
    input.executeTool = async (...args) => {
      calls.push(args);
      return { text: "offline file content" };
    };
    input.session = {
      save: async (state) => {
        saves.push(state);
      },
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(input, {
      spaceId: "test-space",
      signal: AbortSignal.timeout(20000),
    }))
      events.push(event);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "read_file",
      { path: "notes.txt" },
      expect.stringContaining("test-run:"),
      undefined,
      expect.any(AbortSignal),
    ]);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toContain("bridged result");
    expect(events.at(-1)?.type).toBe("done");
    expect(saves.length).toBeGreaterThan(0);
    expect(JSON.stringify(saves)).not.toContain("fake-backend-only-key");
    expect(JSON.stringify(saves)).toContain("toolResult");
    expect(model.requests).toHaveLength(2);
    expect(host.reaped).toBe(host.starts);
  }, 30000);
  it("persists an actual RPC approval result before a consumer can stop the iterator", async () => {
    const model = await emulator();
    const host = createTestProcessHost();
    const runtime = new PiAgentRuntime({ host });
    const input = request(model.baseUrl);
    const saves: unknown[] = [];
    input.executeTool = async () => approvalPausedToolResult();
    input.session = {
      save: async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        saves.push(state);
      },
    };
    for await (const event of runtime.run(input, {
      spaceId: "test-space",
      signal: AbortSignal.timeout(20000),
    })) {
      if (event.type === "tool") {
        expect(JSON.stringify(saves)).toContain("toolResult");
        expect(JSON.stringify(saves)).toContain("Waiting for approval");
        break;
      }
    }
    expect(saves.length).toBeGreaterThan(0);
    expect(model.requests).toHaveLength(1);
    expect(host.reaped).toBe(host.starts);
  }, 30000);
  it("restores Pi entries without duplicating legacy user and assistant history", async () => {
    const model = await emulator();
    const host = createTestProcessHost();
    const runtime = new PiAgentRuntime({ host });
    let state: unknown;
    const input = request(model.baseUrl);
    input.tools = [];
    input.history = [{ id: "legacy-one", role: "user", content: "Legacy context marker" }];
    input.session = {
      save: async (value) => {
        state = value;
      },
    };
    for await (const _ of runtime.run(input, {
      spaceId: "test-space",
      signal: AbortSignal.timeout(20000),
    })) {
      /* Consume actual RPC. */
    }
    input.runId = "test-run-two";
    input.sourceMessageId = "message-two";
    input.prompt = "Continue";
    input.history.push(
      { id: "message-one", role: "user", content: "Read notes" },
      { id: "assistant-one", role: "assistant", content: "The bridged result is ready." },
    );
    input.session = {
      restore: state,
      save: async (value) => {
        state = value;
      },
    };
    for await (const _ of runtime.run(input, {
      spaceId: "test-space",
      signal: AbortSignal.timeout(20000),
    })) {
      /* Consume actual RPC. */
    }
    const persisted = JSON.stringify(state);
    expect(persisted.match(/Legacy context marker/g)).toHaveLength(1);
    expect(persisted.match(/User request:/g)).toHaveLength(2);
    expect(host.reaped).toBe(2);
  }, 30000);
  it("aborts a quiet actual broker stream and reaps the worker", async () => {
    const model = await emulator({ quiet: true });
    const host = createTestProcessHost();
    const runtime = new PiAgentRuntime({ host });
    const input = request(model.baseUrl);
    const consume = (async () => {
      for await (const _ of runtime.run(input, { spaceId: "test-space" })) {
        /* Consume until abort. */
      }
    })();
    const cancelled = expect(consume).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => model.requests.length, { timeout: 15000 }).toBe(1);
    await runtime.abort(input.runId);
    await cancelled;
    expect(host.reaped).toBe(1);
  }, 30000);
  it("latches approval before sibling effects and keeps routes backend-owned", async () => {
    const input = request("http://unused.invalid");
    input.tools.push({
      name: "write_file",
      description: "Write",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    });
    const calls: string[] = [];
    input.executeTool = async (name) => {
      calls.push(name);
      return approvalPausedToolResult();
    };
    const authority = new RunAuthority(input, new AbortController().signal);
    const bridge = new ToolBridge(input, authority, () => undefined);
    const results = await Promise.allSettled([
      bridge.invoke({
        handle: bridge.catalog[0]!.handle,
        callId: "one",
        args: { path: "notes.txt" },
      }),
      bridge.invoke({
        handle: bridge.catalog[1]!.handle,
        callId: "two",
        args: { path: "notes.txt", content: "forbidden" },
      }),
    ]);
    expect(calls).toEqual(["read_file"]);
    expect(results[1]?.status).toBe("rejected");
    await expect(bridge.invoke({ handle: "forged", callId: "three", args: {} })).rejects.toThrow(
      "handle",
    );
  });
  it("decodes split UTF-8 with LF only and rejects truncated frames", async () => {
    const channel = new AsyncChannel<Uint8Array>();
    const frame = new TextEncoder().encode(JSON.stringify({ text: "é\u2028value" }) + "\n");
    for (const byte of frame) channel.push(Uint8Array.of(byte));
    channel.close();
    const values = [];
    for await (const value of readJsonFrames({
      incoming: channel,
      write: async () => undefined,
      close: async () => undefined,
    }))
      values.push(value);
    expect(values).toEqual([{ text: "é\u2028value" }]);
  });
});
