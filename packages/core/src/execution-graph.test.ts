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
  it("never infers relationship or code from similar names/text", () => {
    const graph = projectExecutionGraph([
      event("first", "agent.tool.called", { name: "fabric_exec", executionId: "one" }),
      event("second", "agent.tool.called", { name: "fabric_exec", executionId: "two" }),
    ]);
    expect(graph.edges.some((edge) => edge.kind === "calls")).toBe(false);
    expect(graph.nodes.every((node) => !node.code)).toBe(true);
  });
});
