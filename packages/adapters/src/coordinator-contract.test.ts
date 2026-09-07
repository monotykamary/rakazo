import { COORDINATOR_INSTRUCTIONS } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { builtinAgentTools, DELEGATION_TOOL_NAMES } from "./builtin-tools.js";

describe("coordinator tool contract", () => {
  it("registers real bot creation and asynchronous messaging named by onboarding", () => {
    for (const name of ["spawn_bot", "message_bot", "dispatch_work"]) {
      expect(COORDINATOR_INSTRUCTIONS).toContain(name);
      expect(builtinAgentTools.filter((tool) => tool.name === name)).toHaveLength(1);
      expect(DELEGATION_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(builtinAgentTools.find((tool) => tool.name === "spawn_bot")?.inputSchema).toMatchObject({
      required: ["name"],
      properties: { instructions: { type: "string" }, prompt: { type: "string" } },
    });
  });

  it("does not mistake turn-bound Fabric helpers for durable background work", () => {
    expect(COORDINATOR_INSTRUCTIONS).toContain("turn-bound");
    expect(COORDINATOR_INSTRUCTIONS).toContain(
      "Never equate spawning an in-process helper with durable dispatch",
    );
    expect(COORDINATOR_INSTRUCTIONS).toContain("anti-jobs");
    expect(COORDINATOR_INSTRUCTIONS).toContain("If the request is already clear, act");
    expect(COORDINATOR_INSTRUCTIONS).toContain("not a lasting bot");
  });
});
