import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { messageReaction, projectMessageReactions } from "./message-reactions.js";

const message = (id: string, text: string, replyToMessageId?: string) => ({
  id,
  role: "user",
  blocks: [{ kind: "text", text }] as MessageBlock[],
  replyToMessageId,
});

describe("reaction conversation presentation", () => {
  it("keeps distinct and repeated reactions without replacing earlier messages", () => {
    const parent = message("parent", "Hello");
    const messages = [
      parent,
      message("one", "❤️", parent.id),
      message("two", "👍", parent.id),
      message("three", "❤️", parent.id),
    ];
    const result = projectMessageReactions(messages);
    expect(result.visibleMessages).toEqual([parent]);
    expect([...result.reactions.get(parent.id)!]).toEqual([
      ["❤️", 2],
      ["👍", 1],
    ]);
    expect(messages).toHaveLength(4);
  });
  it("keeps replies visible when their parent is outside the loaded page", () => {
    const reply = message("reply", "❤️", "old-parent");
    expect(projectMessageReactions([reply]).visibleMessages).toEqual([reply]);
  });
  it("does not collapse ordinary replies, standalone emoji, or bot messages", () => {
    expect(messageReaction(message("one", "❤️"))).toBeNull();
    expect(messageReaction(message("two", "❤️ thank you", "parent"))).toBeNull();
    expect(messageReaction({ ...message("three", "❤️", "parent"), role: "bot" })).toBeNull();
  });
  it("folds the legacy thumbs-up flag into the target's counts without hiding it", () => {
    const parent = { ...message("parent", "Hello"), thumbsUp: true };
    const result = projectMessageReactions([parent]);
    expect(result.visibleMessages).toEqual([parent]);
    expect([...result.reactions.get("parent")!]).toEqual([["👍", 1]]);
  });
  it("renders legacy thumbs-up alongside new emoji replies deterministically", () => {
    const parent = { ...message("parent", "Hello"), thumbsUp: true };
    const messages = [
      parent,
      message("one", "❤️", parent.id),
      { ...message("two", "👍", parent.id), thumbsUp: true },
    ];
    const result = projectMessageReactions(messages);
    expect(result.visibleMessages).toEqual([parent]);
    // Parent's persisted thumbs-up + the 👍 reply itself + that reply's own legacy thumbs-up.
    expect([...result.reactions.get(parent.id)!]).toEqual([
      ["👍", 3],
      ["❤️", 1],
    ]);
  });
  it("keeps an ordinary reply with a legacy thumbs-up visible under its own count", () => {
    const parent = message("parent", "Hello");
    const reply = { ...message("reply", "Thanks!", parent.id), thumbsUp: true };
    const result = projectMessageReactions([parent, reply]);
    expect(result.visibleMessages).toEqual([parent, reply]);
    expect([...result.reactions.get("reply")!]).toEqual([["👍", 1]]);
  });
});
