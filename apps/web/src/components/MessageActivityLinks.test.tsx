import { i18n } from "@lingui/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

import { MessageActivityLinks } from "./MessageActivityLinks";

i18n.load("en", {});
i18n.activate("en");
const props = {
  peerBot: () => undefined,
  onPeer: () => undefined,
  onExecution: () => undefined,
  onRoutine: () => undefined,
};
describe("message activity links", () => {
  it("does not add chrome for ordinary chat", () => {
    expect(renderToString(<MessageActivityLinks {...props} activities={[]} />)).toBe("");
  });
  it("renders a concise counted peer link and real execution target", () => {
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
    expect(html).toContain("rakazo-bot-avatar");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("Execution");
    expect(html).not.toContain("Queue");
    expect(html).not.toContain("Paused");
  });
});
