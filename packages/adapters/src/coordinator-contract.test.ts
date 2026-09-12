import { COORDINATOR_INSTRUCTIONS } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { builtinAgentTools, DELEGATION_TOOL_NAMES } from "./builtin-tools.js";

describe("coordinator tool contract", () => {
  it("names Fabric session primitives instead of product delegation tools", () => {
    for (const name of ["agents.create", "agents.followUp", "agents.spawn", "agents.run", "agents.remove"]) {
      expect(COORDINATOR_INSTRUCTIONS).toContain(name);
    }
    for (const name of ["spawn_bot", "message_bot", "dispatch_work", "run_subagent", "handoff_to_bot"]) {
      expect(COORDINATOR_INSTRUCTIONS).not.toContain(name);
      expect(builtinAgentTools.filter((tool) => tool.name === name)).toHaveLength(0);
      expect(DELEGATION_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("does not mistake turn-bound Fabric helpers for durable background work", () => {
    expect(COORDINATOR_INSTRUCTIONS).toContain("turn-bound");
    expect(COORDINATOR_INSTRUCTIONS).toContain("Never equate a session helper with durable spawn");
    expect(COORDINATOR_INSTRUCTIONS).toContain("anti-jobs");
    expect(COORDINATOR_INSTRUCTIONS).toContain("If the request is already clear, act");
    expect(COORDINATOR_INSTRUCTIONS).toContain("lasting peer");
  });
});
