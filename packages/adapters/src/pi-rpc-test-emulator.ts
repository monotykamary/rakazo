import { createServer } from "node:http";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { AgentProcessHost } from "./pi-rpc-protocol.js";
import { createTestProcessHost } from "./pi-rpc-test-host.js";
import { PiAgentRuntime } from "./pi-runtime.js";

export async function createRpcHarness(
  options: {
    wrapHost?: (host: AgentProcessHost) => AgentProcessHost;
    /** Extra startup headroom for tests that launch multiple real workers. */
    runTimeoutMs?: number;
    estimateUsage?: boolean;
    quiet?: boolean;
    error?: boolean;
    errorStatus?: number;
    empty?: boolean;
    tool?: { name: string; args: Record<string, unknown> };
  } = {},
) {
  const nativeRef: Record<string, string> = {
    read_file: "pi.read",
    write_file: "pi.write",
    edit_file: "pi.edit",
    list_files: "pi.ls",
    shell: "pi.bash",
    run_subagent: "agents.run",
  };
  const requests: Array<Record<string, any>> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    requests.push(input);
    if (options.error) {
      res.writeHead(options.errorStatus ?? 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "offline model rejected request" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (options.quiet) {
      res.flushHeaders();
      return;
    }
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: "offline-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const hasTool = input.messages.some((message: { role: string }) => message.role === "tool");
    if (
      options.tool &&
      !hasTool &&
      !JSON.stringify(input.messages).includes("Complete the delegated task.") &&
      input.tools?.some(
        (tool: { function: { name: string } }) => tool.function.name === "fabric_exec",
      )
    ) {
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "offline-call",
            type: "function",
            function: {
              name: "fabric_exec",
              arguments: JSON.stringify(
                options.tool.name === "fabric_exec"
                  ? options.tool.args
                  : {
                      code: `return await tools.call({ref:${JSON.stringify(nativeRef[options.tool.name] ?? `extensions.${options.tool.name}`)},args:${JSON.stringify(options.tool.args)}});`,
                    },
              ),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: options.empty ? "" : "Offline answer." });
      chunk({}, "stop");
    }
    res.write(
      `data: ${JSON.stringify({ id: "offline", choices: [], usage: { prompt_tokens: options.estimateUsage ? Math.ceil(JSON.stringify(input.messages).length / 4) : 20, completion_tokens: 8, total_tokens: options.estimateUsage ? Math.ceil(JSON.stringify(input.messages).length / 4) + 8 : 28 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Emulator failed");
  const host = createTestProcessHost();
  const runtime = new PiAgentRuntime({ host: options.wrapHost?.(host) ?? host });
  const request: AgentRunRequest = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    sourceMessageId: "source",
    prompt: "Continue",
    instructions: "Follow the user.",
    history: [],
    tools: [],
    model: {
      provider: "openai-compatible",
      id: "offline-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fake-backend-key",
      acceptsImages: true,
    },
  };
  return {
    requests,
    host,
    runtime,
    request,
    async run(overrides: Partial<AgentRunRequest> = {}) {
      const events: AgentRuntimeEvent[] = [];
      try {
        for await (const event of runtime.run(
          { ...request, ...overrides },
          { spaceId: "space", signal: AbortSignal.timeout(options.runTimeoutMs ?? 20000) },
        ))
          events.push(event);
      } catch (error) {
        throw new Error(
          `${String(error)} ${String(error instanceof Error ? error.cause : "")}\nTest worker stderr: ${host.stderr.join("")}`,
        );
      }
      return events;
    },
    async close() {
      await runtime.abort(request.runId);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
