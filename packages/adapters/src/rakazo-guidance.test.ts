import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { managedCoreTools, textResult } from "./pi-managed-tools.js";
import {
  botRuntimeInstructions,
  buildRakazoGuidance,
  RAKAZO_SKILL_PATH,
  withRakazoSkillRead,
} from "./rakazo-guidance.js";

describe("bot runtime instructions", () => {
  it("preserves explicit instructions verbatim apart from surrounding whitespace", () => {
    const explicit = "Answer in French.\n\n  Keep this indentation.\nUse `custom_tool` when asked.";
    expect(botRuntimeInstructions(` \n${explicit}\n\t`)).toBe(explicit);
    expect(botRuntimeInstructions(explicit, false)).toBe(explicit);
    expect(botRuntimeInstructions(" \n\t")).toBe("");
  });
  it("adds only the narrow captured-project file constraint for dispatched work", () => {
    const constraint = botRuntimeInstructions("", true);
    expect(botRuntimeInstructions(" \nExplicit bot instruction.\n ", true)).toBe(
      `Explicit bot instruction.\n\n${constraint}`,
    );
    expect(botRuntimeInstructions(" \n\t", true)).toBe(constraint);
    expect(constraint).toContain("captured project/worktree");
    expect(constraint).toContain("Use only the provided file tools.");
    expect(constraint).toContain(
      "Shell commands, GUI, integrations and further delegation are unavailable.",
    );
    expect(constraint).toContain("Do not claim tests ran.");
    expect(constraint).toContain("Never broaden your scope or disclose secrets.");
    expect(constraint).not.toMatch(
      /Rakazo|Fabric|fabric_exec|extensions\.|get_bot_context|manage_office|skill_create|SKILL\.md|roster|scratchpad/,
    );
    expect(constraint.length).toBeLessThan(450);
  });
});

describe("Rakazo guidance", () => {
  it("names exposed tools without inventing or renormalizing them", () => {
    const text = buildRakazoGuidance({
      exposedToolNames: ["bot_template_2", "office_plan"],
      fabricAvailable: true,
    });
    expect(text).toContain("extensions.bot_template_2, extensions.office_plan");
    expect(text).toContain("fabric_exec using pi.read");
    expect(text.length).toBeLessThan(900);
    expect(text).not.toContain("## Bots");
  });
  it("does not assume Fabric when absent", () => {
    const text = buildRakazoGuidance({ exposedToolNames: [], fabricAvailable: false });
    expect(text).not.toMatch(/Fabric|fabric_exec|extensions\./);
    expect(text).toContain("available read tool");
  });
  it("serves only the exact bundled resource, through canonical managed read pagination", async () => {
    const broker = vi.fn(async () => textResult(JSON.stringify({ content: "computer" })));
    let paused = false;
    const call = await withRakazoSkillRead(broker, () => paused);
    const read = managedCoreTools(call).find((tool) => tool.name === "read")!;
    const result = await read.execute(
      "read",
      { path: RAKAZO_SKILL_PATH },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toEqual([
      { type: "text", text: await readFile(RAKAZO_SKILL_PATH, "utf8") },
    ]);
    const page = await read.execute(
      "page",
      { path: RAKAZO_SKILL_PATH, offset: 2, limit: 1 },
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.stringify(page)).toContain("name: rakazo");
    expect(broker).not.toHaveBeenCalled();
    for (const path of [
      `${RAKAZO_SKILL_PATH}/../other`,
      `${RAKAZO_SKILL_PATH}.bak`,
      "/worker/private.txt",
      "project.txt",
    ]) {
      await call("read_file", { path });
      expect(broker).toHaveBeenLastCalledWith("read_file", { path }, undefined, undefined);
    }
    await expect(
      call("write_file", { path: RAKAZO_SKILL_PATH, content: "replace" }),
    ).rejects.toThrow("read-only");
    await expect(call("edit_file", { path: RAKAZO_SKILL_PATH })).rejects.toThrow("read-only");
    paused = true;
    await expect(call("read_file", { path: RAKAZO_SKILL_PATH })).rejects.toThrow("paused");
    paused = false;
    await expect(
      call("read_file", { path: RAKAZO_SKILL_PATH }, AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
