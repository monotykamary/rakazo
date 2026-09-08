import { describe, expect, it } from "vitest";
import { BOT_OFFICE_PROMPTS, resolveComposerSendPlan } from "./index.js";

describe("office user prompts", () => {
  it.each(Object.values(BOT_OFFICE_PROMPTS))("sends %s as an ordinary user message", (text) => {
    const plan = resolveComposerSendPlan({ text, mentions: [], hasAttachments: false });
    expect(plan.shouldSend).toBe(true);
    expect(plan.shouldRunRoutines).toBe(false);
    expect(plan.rerouteGroupId).toBeNull();
    expect(plan.trimmed).toBe(text);
    expect(plan.mentionPayload).toEqual([]);
    expect(text).not.toMatch(/pairing|--code|https?:|assign|deploy/i);
  });
});
