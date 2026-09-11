import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatTurns } from "./ChatTurns";

describe("chat turns", () => {
  it("uses the same bubbles as the thread", () => {
    const html = renderToString(
      <ChatTurns
        turns={[
          { id: "task", role: "user", text: "Scan the diff", speakerName: "You" },
          { id: "reply", role: "bot", text: "No new component.", speakerName: "Scout" },
        ]}
      />,
    );
    expect(html).toContain('data-testid="message-user-bubble"');
    expect(html).toContain('data-testid="message-bot-bubble"');
    expect(html).toContain("Scan the diff");
    expect(html).toContain("Scout");
  });
});
