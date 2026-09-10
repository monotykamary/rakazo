import { i18n } from "@lingui/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

import {
  lastMessageExecution,
  MessageActivityLinks,
  MessageExecutionButton,
} from "./MessageActivityLinks";

i18n.load("en", {});
i18n.activate("en");
const props = {
  peerBot: () => undefined,
  onPeer: () => undefined,
  onRoutine: () => undefined,
};
describe("message activity links", () => {
  it("does not add chrome for ordinary chat", () => {
    expect(renderToString(<MessageActivityLinks {...props} activities={[]} />)).toBe("");
  });
  it("hides execution from the under-bubble row", () => {
    expect(
      renderToString(
        <MessageActivityLinks {...props} activities={[{ kind: "execution", runId: "run" }]} />,
      ),
    ).toBe("");
    const html = renderToString(
      <MessageActivityLinks
        {...props}
        activities={[
          { kind: "peer", botId: "bot", peerBotId: "research", peerBotName: "Research", count: 2 },
          { kind: "execution", runId: "run" },
        ]}
      />,
    );
    expect(html).toContain('aria-label="2 messages with Research"');
    expect(html).toContain("rakazo-organic-avatar");
    expect(html).not.toContain(">Execution<");
    expect(lastMessageExecution([{ kind: "execution", runId: "run", botId: "bot" }])).toEqual({
      kind: "execution",
      runId: "run",
      botId: "bot",
    });
    expect(
      renderToString(
        <MessageExecutionButton runId="run" botId="bot" onExecution={() => undefined} />,
      ),
    ).toContain('aria-label="Execution"');
  });
});
