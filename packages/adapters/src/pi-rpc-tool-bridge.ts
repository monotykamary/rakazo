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
  private pauseLatched = false;
  onPause?: () => void;
  get paused() {
    return this.pauseLatched;
  }
  set paused(value: boolean) {
    if (!value || this.pauseLatched) return;
    this.pauseLatched = true;
    this.onPause?.();
  }
  gracefulPause = false;
  count = 0;
  readonly workerBridges = new Map<string, import("./pi-rpc-transport.js").JsonPeer>();
  rootState?: Record<string, unknown>;
  readonly deferredEvents: AgentRuntimeEvent[] = [];
  chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly request: AgentRunRequest,
    readonly signal: AbortSignal,
  ) {}
  async checkLease(effects = false, checkpoint = false) {
    this.signal.throwIfAborted();
    if (
      (await this.request.assertActive?.({
        effects,
        ...(checkpoint ? { checkpoint: true } : {}),
      })) === "pause"
    ) {
      this.gracefulPause = true;
      this.paused = true;
    }
    this.signal.throwIfAborted();
  }
  async check(effects = false) {
    this.signal.throwIfAborted();
    if (this.paused) throw new Error("Managed run is paused");
    await this.checkLease(effects);
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
    connector?: { id: string; resourceId?: string; toolName: string };
  }>;
  private readonly tools = new Map<string, ConnectorTool>();
  private readonly used = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  pendingPauseEvents: AgentRuntimeEvent[] = [];
  constructor(
    private readonly request: AgentRunRequest,
    readonly authority: RunAuthority,
    private readonly emit: (event: AgentRuntimeEvent) => void,
    private readonly participantSignal?: AbortSignal,
  ) {
    const definitions = structuredClone(request.tools);
    const names = normalizeAgentToolNames(definitions);
    this.catalog = definitions.map((tool, index) => {
      const handle = randomUUID();
      const mcp = tool.protocol === "mcp" || tool.route?.connectorId === "mcp";
      this.tools.set(handle, tool);
      return {
        handle,
        name: names[index]!,
        description: tool.description,
        parameters: parametersFor(tool),
        argumentKind: tool.name,
        ...(tool.route
          ? {
              connector: {
                id: mcp ? "mcp" : tool.route.connectorId,
                toolName: tool.route.toolName,
                ...(tool.route.resourceId
                  ? {
                      resourceId: mcp
                        ? `${tool.route.connectorId}:${tool.route.resourceId}`
                        : tool.route.resourceId,
                    }
                  : {}),
              },
            }
          : {}),
      };
    });
  }
  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
  invoke(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const operationSignal = AbortSignal.any([
      this.authority.signal,
      ...(this.participantSignal ? [this.participantSignal] : []),
      ...(signal ? [signal] : []),
    ]);
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
      operationSignal.throwIfAborted();
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
      } else {
        if (!this.request.executeTool)
          throw new Error("Tool unavailable without an authorized executor");
        result = await this.request.executeTool(
          tool.name,
          args,
          executionId,
          tool.route,
          operationSignal,
        );
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
        executionId,
        result: output,
        paused,
        isError: structured?.isError === true || Boolean(structured?.error),
      };
    };
    const invoked = this.authority.serialize(dispatch);
    const work = invoked.catch((error) => {
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
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work)).catch(() => undefined);
    return work;
  }
  publishPause() {
    for (const event of this.pendingPauseEvents.splice(0)) this.emit(event);
  }
}
