import type { ProductEvent } from "@rakazo/contracts";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

import { ExecutionTraceList } from "./ExecutionTraceList";

function event(
  type: ProductEvent["type"],
  payload: ProductEvent["payload"] = {},
  seq = 1,
): ProductEvent {
  return {
    id: `${type}:${seq}`,
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    seq,
    type,
    createdAt: "2026-09-10T12:10:54.985Z",
    payload,
  };
}

describe("execution trace list", () => {
  it("renders a chain of thought instead of boxed event types", () => {
    const html = renderToString(
      <ExecutionTraceList
        now={Date.parse("2026-09-10T12:11:00.000Z")}
        events={[
          event("thread.message.created", {}, 29),
          event("run.started", {}, 30),
          event("thread.progress", { text: "Reading files" }, 31),
          event("thread.progress", { text: "Planning the change" }, 32),
          event("agent.tool.called", { name: "fabric_exec" }, 33),
        ]}
      />,
    );
    expect(html).toContain('data-testid="execution-trace"');
    expect(html).toContain("Reasoning");
    expect(html).toContain("Tool");
    expect(html).toContain("Planning the change");
    expect(html).toContain("fabric_exec");
    expect(html).not.toContain("thread.progress");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("rounded border border-border p-3");
  });
});
