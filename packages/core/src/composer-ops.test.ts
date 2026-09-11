import { describe, expect, it } from "vitest";
import { composerOps, composerOpsVisible } from "./composer-ops.js";

describe("composer ops", () => {
  it("hides empty counts", () => {
    expect(composerOpsVisible(composerOps({}))).toBe(false);
  });

  it("keeps active runs and armed routines", () => {
    const ops = composerOps({
      runs: [
        { id: "run-live", botId: "bot", status: "running" },
        { id: "run-done", botId: "bot", status: "completed" },
      ],
      botNames: { bot: "Scout" },
      routines: [
        { id: "watch", name: "Merge watch", active: true },
        { id: "paused", name: "Paused", active: false },
      ],
    });
    expect(ops.working).toEqual([{ id: "run-live", botId: "bot", name: "Scout" }]);
    expect(ops.listening).toEqual([{ id: "watch", name: "Merge watch" }]);
    expect(composerOpsVisible(ops)).toBe(true);
  });

  it("keeps the latest https pull request per cloud agent", () => {
    const ops = composerOps({
      messages: [
        {
          blocks: [
            {
              kind: "cloud_agent",
              agentId: "one",
              title: "Old",
              status: "running",
              url: "https://example.test/one",
              prUrl: "https://github.com/example/repo/pull/1",
            },
          ],
        },
        {
          blocks: [
            {
              kind: "cloud_agent",
              agentId: "one",
              title: "New",
              status: "finished",
              url: "https://example.test/one",
              prUrl: "https://github.com/example/repo/pull/2",
            },
            {
              kind: "cloud_agent",
              agentId: "bad",
              title: "Ignored",
              status: "running",
              url: "https://example.test/bad",
              prUrl: "http://github.com/example/repo/pull/3",
            },
          ],
        },
      ],
    });
    expect(ops.pullRequests).toEqual([
      { id: "one", title: "New", url: "https://github.com/example/repo/pull/2" },
    ]);
  });

  it("hides pull requests a day after they merge", () => {
    const mergedAt = "2026-01-01T00:00:00.000Z";
    const block = {
      kind: "cloud_agent" as const,
      agentId: "one",
      title: "Merged",
      status: "finished" as const,
      url: "https://example.test/one",
      prUrl: "https://github.com/example/repo/pull/2",
      prMergedAt: mergedAt,
    };
    expect(
      composerOps({
        messages: [{ blocks: [block] }],
        now: Date.parse(mergedAt) + 12 * 60 * 60 * 1000,
      }).pullRequests,
    ).toHaveLength(1);
    expect(
      composerOps({
        messages: [{ blocks: [block] }],
        now: Date.parse(mergedAt) + 24 * 60 * 60 * 1000,
      }).pullRequests,
    ).toEqual([]);
  });
});
