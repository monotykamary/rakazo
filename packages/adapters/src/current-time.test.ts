import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { runAutoReviewJudge } from "./auto-review.js";
import { formatCurrentTimeInstruction } from "./current-time.js";

it("includes the clock in real safety-review runtime requests", async () => {
  let request: AgentRunRequest | undefined;
  const runtime: AgentRuntime = {
    describe: () => ({
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: true },
    }),
    abort: async () => {},
    run: async function* (input: AgentRunRequest) {
      request = input;
      yield { type: "done", text: '{"decision":"pass","reason":"fits the task"}' };
    },
  };
  const result = await runAutoReviewJudge({
    runtime,
    checker: { provider: "scripted", model: "checker" },
    prompt: "Review",
    runId: "run",
    spaceId: "space",
    userId: "user",
    botId: "bot",
    threadId: "thread",
  });
  expect(result.decision).toBe("pass");
  expect(request?.instructions).toContain("Current date and time:");
  expect(request?.instructions).toContain("fast safety checker");
});
describe("current time instruction", () => {
  it("anchors the date and weekday to UTC rather than the host timezone", () => {
    expect(formatCurrentTimeInstruction(new Date("2026-09-18T23:30:00-07:00"))).toContain(
      "Saturday, 2026-09-19T06:30:00Z (UTC)",
    );
  });
  it("omits milliseconds and does not ask the model to infer today", () => {
    const text = formatCurrentTimeInstruction(new Date("2026-01-01T12:34:56.789Z"));
    expect(text).toContain("Thursday, 2026-01-01T12:34:56Z");
    expect(text).toContain("not dates from training data or quoted history");
    expect(text).not.toContain(".789");
  });
});
