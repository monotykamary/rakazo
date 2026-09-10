import type { ProductEvent } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { projectExecutionGraph } from "./execution-graph.js";

const event = (
  id: string,
  type: ProductEvent["type"],
  payload: Record<string, unknown>,
): ProductEvent => ({
  id,
  type,
  payload,
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  runId: "run",
  seq: 1,
  createdAt: "2026-01-01",
});
describe("evidence-backed execution graph", () => {
  it.each([undefined, "status", "result"])(
    "does not infer a reply from delivery receipt (%s)",
    (intent) => {
      const payload = {
        messageId: "inbound",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "sender",
            fromBotName: "Sender",
            text: "Message",
            returnToMessageId: "receipt",
            intent,
          },
        ],
      };
      const request = projectExecutionGraph([event("received", "thread.message.created", payload)]);
      expect(request.edges.some((edge) => edge.kind === "replies" || edge.kind === "results")).toBe(
        false,
      );
      expect(request.nodes.some((node) => node.messageId === "receipt")).toBe(false);
      const reply = projectExecutionGraph([
        event("received", "thread.message.created", {
          ...payload,
          replyToMessageId: "actual-target",
        }),
      ]);
      expect(reply.edges).toContainEqual(
        expect.objectContaining({
          from: "message:inbound",
          to: "message:actual-target",
          kind: intent === "result" ? "results" : "replies",
        }),
      );
    },
  );
  it.each(["run", "parent"])(
    "retains recorded source ownership including same run (%s)",
    (sourceRunId) => {
      const graph = projectExecutionGraph(
        [],
        [
          {
            runId: "run",
            botId: "bot",
            status: "running",
            trigger: "bot_message",
            sourceMessageId: "source",
            sourceRunId,
          },
        ],
      );
      expect(graph.nodes.find((node) => node.messageId === "source")?.runId).toBe(sourceRunId);
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          from: `run:${sourceRunId}`,
          to: "message:source",
          kind: "contains",
        }),
      );
    },
  );
  it("projects known bot names without guessing missing names", () => {
    const graph = projectExecutionGraph(
      [event("retained", "run.waiting_input", {})],
      [
        { runId: "run", botId: "bot", botName: "Planner", status: "running", trigger: "user" },
        { runId: "other", botId: "unknown", status: "running", trigger: "user" },
      ],
    );
    expect(graph.nodes.find((node) => node.id === "run:run")?.name).toBe("Planner");
    expect(graph.nodes.find((node) => node.id === "run:other")?.name).toBeUndefined();
  });
  it("links nested executions and delegation using retained parent IDs only", () => {
    const graph = projectExecutionGraph([
      event("call", "agent.tool.called", {
        executionId: "outer",
        name: "fabric_exec",
        args: { code: "return 1" },
      }),
      event("nested", "agent.execution.updated", {
        executionId: "inner",
        parentExecutionId: "outer",
        name: "read",
        status: "completed",
        participantId: "child",
      }),
      event("delegate", "thread.subagent", {
        agentId: "child",
        name: "Reader",
        status: "completed",
        result: "actual result",
      }),
    ]);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: "execution:run:outer",
        to: "execution:run:inner",
        kind: "calls",
        evidence: [{ kind: "event", id: "nested" }],
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: "run:run", to: "participant:run:child", kind: "delegates" }),
    );
    expect(graph.nodes.find((node) => node.executionId === "outer")?.code).toBe("return 1");
    expect(graph.nodes.find((node) => node.executionId === "inner")).not.toHaveProperty("code");
  });
  it("pulls nested fabric tools from TypeScript audits and Python trace.calls", () => {
    const typescript = projectExecutionGraph([
      event("outer", "agent.execution.updated", {
        executionId: "fabric",
        name: "fabric_exec",
        display: { name: "Inspect startup" },
        details: {
          audits: [
            { ref: "pi.read", tool: "read", provider: "pi", args: { path: "src/main.ts" }, success: true },
          ],
        },
      }),
    ]);
    expect(typescript.nodes.find((node) => node.executionId === "fabric")?.name).toBe("Inspect startup");
    expect(typescript.nodes.find((node) => node.name === "pi.read src/main.ts")).toMatchObject({
      kind: "execution",
    });
    expect(typescript.edges).toContainEqual(
      expect.objectContaining({
        from: "execution:run:fabric",
        kind: "calls",
      }),
    );
    const python = projectExecutionGraph([
      event("outer", "agent.execution.updated", {
        executionId: "py",
        name: "fabric_exec",
        details: {
          trace: { calls: [{ ref: "pi.bash", tool: "bash", provider: "pi", args: { command: "bun test" } }] },
        },
      }),
    ]);
    expect(python.nodes.find((node) => node.executionId === "py")?.name).toBe("Fabric program");
    expect(python.nodes.some((node) => node.name === "pi.bash bun test")).toBe(true);
  });
  it("links actual bot messages, waits, continuations and returned results", () => {
    const graph = projectExecutionGraph(
      [
        event("sent", "thread.message.created", {
          messageId: "question",
          blocks: [
            { kind: "bot_message_sent", toBotId: "other", toBotName: "Other", text: "Question" },
          ],
        }),
        event("wait", "run.waiting_input", {}),
        event("retry", "runtime.activity", { activity: "retry", status: "started" }),
      ],
      [
        {
          runId: "answer",
          botId: "other",
          status: "completed",
          trigger: "follow_up",
          sourceMessageId: "response",
          replyToMessageId: "question",
          messageIntent: "result",
        },
      ],
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: "message:response",
        to: "message:question",
        kind: "results",
        evidence: [{ kind: "message", id: "response" }],
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: "message:response", to: "run:answer", kind: "continues" }),
    );
    expect(graph.edges.some((edge) => edge.kind === "waits-for")).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "messages")).toBe(true);
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({ kind: "recovery", name: "retry" }),
    );
    expect(graph.edges.every((edge) => edge.evidence.length > 0)).toBe(true);
  });
  it("projects recorded source senders without inventing source ownership", () => {
    const graph = projectExecutionGraph(
      [],
      [
        {
          runId: "continuation",
          botId: "chief",
          botName: "Chief",
          status: "running",
          trigger: "follow_up",
          sourceMessageId: "reply",
          fromBotId: "researcher",
          fromBotName: "Researcher",
          replyToMessageId: "question",
          messageIntent: "result",
        },
      ],
    );
    expect(graph.nodes.find((node) => node.id === "bot:researcher")).toEqual({
      id: "bot:researcher",
      kind: "participant",
      botId: "researcher",
      name: "Researcher",
      evidence: [{ kind: "message", id: "reply" }],
    });
    expect(graph.edges).toContainEqual({
      id: "messages:bot:researcher:message:reply",
      from: "bot:researcher",
      to: "message:reply",
      kind: "messages",
      evidence: [{ kind: "message", id: "reply" }],
    });
    expect(graph.nodes.find((node) => node.id === "message:reply")).not.toHaveProperty("runId");
    expect(graph.edges.some((edge) => edge.kind === "contains")).toBe(false);
    expect(
      projectExecutionGraph(
        [],
        [
          {
            runId: "run",
            botId: "chief",
            status: "running",
            trigger: "user",
            fromBotId: "researcher",
            fromBotName: "Researcher",
          },
        ],
      ).nodes,
    ).toHaveLength(1);
  });
  it("never infers relationship or code from similar names/text", () => {
    const graph = projectExecutionGraph([
      event("first", "agent.tool.called", { name: "fabric_exec", executionId: "one" }),
      event("second", "agent.tool.called", { name: "fabric_exec", executionId: "two" }),
    ]);
    expect(graph.edges.some((edge) => edge.kind === "calls")).toBe(false);
    expect(graph.nodes.every((node) => !node.code)).toBe(true);
  });
});
