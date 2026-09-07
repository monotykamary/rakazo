import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("../lib/use-queue", () => ({
  useExecution: () => ({
    inspection: { events: [], participants: [], hasMore: false },
    busy: false,
    loadMore: () => undefined,
  }),
}));

import { ExecutionInspector } from "./ExecutionInspector";

const props = {
  botId: "bot",
  threadId: "thread",
  queue: {} as Parameters<typeof ExecutionInspector>[0]["queue"],
};
describe("execution disclosure", () => {
  it("does not offer inert controls when no run is retained", () => {
    const html = renderToString(<ExecutionInspector {...props} runIds={[]} />);
    expect(html).toContain("No retained events");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<select");
  });
  it("does not expose an internal identifier or a single-choice selector", () => {
    const html = renderToString(<ExecutionInspector {...props} runIds={["internal-run-id"]} />);
    expect(html).not.toContain("internal-run-id");
    expect(html).not.toContain("<select");
  });
  it("labels multiple run choices without rendering their internal IDs as copy", () => {
    const html = renderToString(
      <ExecutionInspector {...props} runIds={["first-id", "second-id"]} />,
    );
    expect(html).toContain('value="first-id" selected="">Run 1</option>');
    expect(html).toContain('value="second-id">Run 2</option>');
  });
});
