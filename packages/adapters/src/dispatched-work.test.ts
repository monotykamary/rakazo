import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DispatchWorkInput, WorkToolName } from "@rakazo/contracts";
import { projectPathsOverlap } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { canonicalComputerPath } from "./dispatched-work.js";

const exec = promisify(execFile);

describe("dispatched project scope", () => {
  it("defaults to a bounded file-tool set and registers the same public allowlist", () => {
    expect(
      DispatchWorkInput.parse({ task: "Write a report", project_path: "project" }).tools,
    ).toEqual(["read_file", "list_files", "write_file", "edit_file"]);
    expect(
      builtinAgentTools.find((tool) => tool.name === "dispatch_work")?.inputSchema,
    ).toMatchObject({
      properties: { tools: { items: { enum: WorkToolName.options } } },
      required: ["task", "project_path"],
    });
    for (const tools of [["shell"], ["computer_act"], ["spawn_bot"], ["message_bot"], []]) {
      expect(
        DispatchWorkInput.safeParse({ task: "Task", project_path: "project", tools }).success,
      ).toBe(false);
    }
    for (const project_path of [
      "../project",
      "/project",
      "C:/project",
      "project\\other",
      "project\0other",
    ]) {
      expect(DispatchWorkInput.safeParse({ task: "Task", project_path }).success).toBe(false);
    }
  });

  it("canonicalizes aliases on the authorized computer and denies symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rakazo-work-scope-"));
    try {
      const workspace = join(root, "workspace");
      await mkdir(join(workspace, "alpha"), { recursive: true });
      await mkdir(join(root, "outside"));
      await symlink("alpha", join(workspace, "alias"));
      await symlink("../outside", join(workspace, "escape"));
      const execute = async ([program, ...args]: string[]) => {
        try {
          const result = await exec(program!, args, { cwd: workspace });
          return { stdout: result.stdout, code: 0 };
        } catch {
          return { stdout: "", code: 1 };
        }
      };
      expect(await canonicalComputerPath("alias", execute)).toBe("alpha");
      expect(await canonicalComputerPath("alpha/new/file.txt", execute, false)).toBe(
        "alpha/new/file.txt",
      );
      await expect(canonicalComputerPath("escape", execute)).rejects.toThrow(
        "outside the authorized computer",
      );
      await expect(canonicalComputerPath("escape/new.txt", execute, false)).rejects.toThrow(
        "outside the authorized computer",
      );
      await expect(canonicalComputerPath("missing", execute)).rejects.toThrow("unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed or out-of-scope provider metadata", async () => {
    for (const stdout of [
      "not json",
      JSON.stringify("../escape"),
      JSON.stringify("/host"),
      JSON.stringify(" alpha "),
      "x".repeat(8193),
    ]) {
      await expect(
        canonicalComputerPath("alpha", async () => ({ stdout, code: 0 })),
      ).rejects.toThrow();
    }
  });

  it("conflicts on canonical ancestors, not sibling name prefixes or independent worktrees", () => {
    expect(projectPathsOverlap(".", "alpha")).toBe(true);
    expect(projectPathsOverlap("alpha", "alpha/src")).toBe(true);
    expect(projectPathsOverlap("alpha/src", "alpha")).toBe(true);
    expect(projectPathsOverlap("alpha", "alpha-two")).toBe(false);
    expect(projectPathsOverlap("worktrees/one", "worktrees/two")).toBe(false);
  });
});
