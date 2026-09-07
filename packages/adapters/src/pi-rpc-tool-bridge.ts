import { randomUUID } from "node:crypto";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolExecutionResult,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { isToolPauseResult } from "./approval-effect.js";
import { record, string } from "./pi-rpc-protocol.js";
import {
  describeToolActivity,
  maxToolCallsPerTurn,
  normalizeAgentToolNames,
  parametersFor,
} from "./pi-runtime.js";
import { prepareManagedToolArguments } from "./pi-tool-arguments.js";

/** Shared by every parent/child operation. Latch synchronously before publishing a pause. */
export class RunAuthority {
  paused = false;
  gracefulPause = false;
  count = 0;
  readonly childSessions = new Map<string, unknown>();
  readonly participants = new Map<string, import("./pi-rpc-transport.js").JsonPeer>();
  rootState?: Record<string, unknown>;
  childrenStarted = 0;
  chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly request: AgentRunRequest,
    readonly signal: AbortSignal,
  ) {}
  async check(effects = false) {
    this.signal.throwIfAborted();
    if (this.paused) throw new Error("Managed run is paused");
    if ((await this.request.assertActive?.({ effects })) === "pause") {
      this.gracefulPause = true;
      this.paused = true;
    }
    this.signal.throwIfAborted();
    if (this.paused) throw new Error("Managed run is paused");
  }
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.chain.then(async () => {
      await this.check(true);
      return fn();
    });
    this.chain = work.catch(() => undefined);
    return work;
  }
}

export class ToolBridge {
  readonly catalog: Array<{
    handle: string;
    name: string;
    description: string;
    parameters: unknown;
    argumentKind: string;
  }>;
  private readonly tools = new Map<string, ConnectorTool>();
  private readonly used = new Set<string>();
  pendingPauseEvents: AgentRuntimeEvent[] = [];
  constructor(
    private readonly request: AgentRunRequest,
    readonly authority: RunAuthority,
    private readonly emit: (event: AgentRuntimeEvent) => void,
    private readonly delegate: (args: Record<string, unknown>, id: string) => Promise<unknown>,
  ) {
    const definitions = structuredClone(request.tools);
    const names = normalizeAgentToolNames(definitions);
    this.catalog = definitions.map((tool, index) => {
      const handle = randomUUID();
      this.tools.set(handle, tool);
      return {
        handle,
        name: names[index]!,
        description: tool.description,
        parameters: parametersFor(tool),
        argumentKind: tool.name,
      };
    });
  }
  invoke(value: unknown): Promise<unknown> {
    const input = record(value);
    const handle = string(input.handle);
    const callId = string(input.callId);
    const tool = this.tools.get(handle);
    if (!tool) return Promise.reject(new Error("Unknown managed tool handle"));
    if (this.used.has(callId))
      return Promise.reject(new Error("Managed tool invocation cannot be replayed"));
    this.used.add(callId);
    const args = validateToolArguments(
      { name: tool.name, description: tool.description, parameters: parametersFor(tool) },
      {
        type: "toolCall",
        id: callId,
        name: tool.name,
        arguments: prepareManagedToolArguments(tool.name, record(input.args)),
      },
    ) as Record<string, unknown>;
    const executionId = `${this.request.runId}:${randomUUID()}`;
    const dispatch = async () => {
      const limit = maxToolCallsPerTurn();
      if (limit && ++this.authority.count > limit) {
        this.authority.paused = true;
        throw new Error("Managed tool budget exceeded");
      }
      const event: AgentRuntimeEvent = { type: "tool", name: tool.name, args, executionId };
      let result: unknown;
      let interaction: AgentRuntimeEvent | undefined;
      if (tool.name === "ask_user") {
        const options = Array.isArray(args.options) ? args.options.map(String) : [];
        if (
          options.length < 2 ||
          options.length > 4 ||
          new Set(options).size !== options.length ||
          options.some((x) => !x.trim() || x.length > 80)
        )
          throw new Error("Invalid choice options");
        interaction = {
          type: "ask",
          text: String(args.question),
          actions: options.map((label, index) => ({ id: `choice-${index + 1}`, label })),
        };
        result = {
          kind: "agent_tool_result",
          content: [{ type: "text", text: "Waiting for the user's choice." }],
          details: { approval: "paused" },
          terminate: true,
        };
      } else if (tool.name === "request_takeover") {
        interaction = { type: "takeover", reason: String(args.reason) };
        result = {
          kind: "agent_tool_result",
          content: [{ type: "text", text: "Takeover requested." }],
          details: { approval: "paused" },
          terminate: true,
        };
      } else if (tool.name === "run_subagent") {
        const authorization = this.request.executeTool
          ? await this.authority.serialize(() =>
              this.request.executeTool!(tool.name, args, executionId, tool.route),
            )
          : undefined;
        result =
          isToolPauseResult(authorization) ||
          (authorization && typeof authorization === "object" && "error" in authorization)
            ? authorization
            : await this.delegate(args, executionId);
      } else {
        if (!this.request.executeTool)
          throw new Error("Tool unavailable without an authorized executor");
        result = await this.request.executeTool(tool.name, args, executionId, tool.route);
      }
      const structured =
        result && typeof result === "object"
          ? (result as Partial<AgentToolExecutionResult> & { error?: unknown })
          : undefined;
      const paused =
        this.authority.paused || isToolPauseResult(result) || structured?.terminate === true;
      if (paused) {
        this.authority.paused = true;
        this.pendingPauseEvents.push(event);
        if (interaction) this.pendingPauseEvents.push(interaction);
      } else {
        this.emit({
          type: "progress",
          text: describeToolActivity(tool.name, args),
          activity: true,
        });
        this.emit(event);
      }
      const output =
        structured?.kind === "agent_tool_result"
          ? structured
          : {
              content: [
                {
                  type: "text",
                  text: typeof result === "string" ? result : JSON.stringify(result ?? null),
                },
              ],
              details: result,
            };
      const evidence: AgentRuntimeEvent = {
        type: "execution",
        executionId,
        name: tool.name,
        status: paused
          ? "paused"
          : structured?.isError || structured?.error
            ? "failed"
            : "completed",
        participantId: this.request.runId,
      };
      if (paused) this.pendingPauseEvents.push(evidence);
      else this.emit(evidence);
      return {
        result: output,
        paused,
        isError: structured?.isError === true || Boolean(structured?.error),
      };
    };
    // Child sessions share the serial inner-effect gate, not a gate held by their parent.
    const invoked =
      tool.name === "run_subagent"
        ? this.authority.check(true).then(dispatch)
        : this.authority.serialize(dispatch);
    return invoked.catch((error) => {
      if (!this.authority.gracefulPause) throw error;
      this.pendingPauseEvents.push({
        type: "execution",
        executionId,
        name: tool.name,
        status: "paused",
        participantId: this.request.runId,
      });
      return {
        paused: true,
        result: {
          content: [{ type: "text", text: "Paused" }],
          details: { queue: "paused" },
          terminate: true,
        },
      };
    });
  }
  publishPause() {
    for (const event of this.pendingPauseEvents.splice(0)) this.emit(event);
  }
}
