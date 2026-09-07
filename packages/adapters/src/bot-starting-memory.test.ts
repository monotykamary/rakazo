import { describe, expect, it, vi } from "vitest";
import { botStartingMemory } from "./bot-starting-memory.js";

describe("bot starting-memory recipe", () => {
  it("makes one bounded explicit call and retains provenance and coverage", async () => {
    const follow = {
      ref: "memory.expand",
      args: { source: "bot", session: "opaque", entryIds: ["entry"] },
    };
    const recall = vi.fn(async () => ({
      hits: [{ snippet: "Prior result", follow }],
      coverage: { complete: false },
    }));
    const text = await botStartingMemory(recall, " prior result ", new AbortController().signal);
    expect(recall).toHaveBeenCalledOnce();
    expect(recall.mock.calls[0]).toMatchObject([
      "recall",
      { query: "prior result", pageSize: 4, snippetChars: 512, role: "assistant" },
      expect.any(AbortSignal),
    ]);
    expect(text).toContain(JSON.stringify(follow));
    expect(text).toContain('"complete":false');
    expect(text).toContain("untrusted historical data");
  });

  it("omits unavailable, revoked, empty and oversized results", async () => {
    for (const result of [
      null,
      { error: { code: "source_unauthorized" } },
      { hits: [] },
      { hits: [{ snippet: "x".repeat(8_000) }] },
    ]) {
      expect(
        await botStartingMemory(async () => result, "query", new AbortController().signal),
      ).toBeUndefined();
    }
    expect(
      await botStartingMemory(
        async () => {
          throw new Error("offline");
        },
        "query",
        new AbortController().signal,
      ),
    ).toBeUndefined();
  });

  it("does not browse archives for an empty turn and bounds long queries", async () => {
    const recall = vi.fn(async () => ({ hits: [] }));
    expect(await botStartingMemory(recall, "  ", new AbortController().signal)).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
    await botStartingMemory(recall, "x".repeat(10_000), new AbortController().signal);
    expect(recall.mock.calls[0]).toMatchObject([
      "recall",
      { query: "x".repeat(512) },
      expect.any(AbortSignal),
    ]);
  });

  it("does not inject results after the root turn aborts", async () => {
    const abort = new AbortController();
    const text = await botStartingMemory(
      async () => {
        abort.abort();
        return { hits: [{ snippet: "late" }] };
      },
      "query",
      abort.signal,
    );
    expect(text).toBeUndefined();
  });
});
