import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalPiRuntime } from "./pi-local-runtime.js";
import {
  readLocalPiEmulatorLog,
  writeLocalPiEmulator,
  writeLocalPiScenario,
} from "./pi-local-runtime-test-helper.js";

describe("local Pi between-run placement continuity", () => {
  let root: string;
  let workspace: string;
  let target: string;
  let runtime: LocalPiRuntime;
  let saved: Record<string, unknown>;
  let oldFile: string;
  const entry = `${JSON.stringify({ type: "message", id: "native-entry", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Native-only history" } })}\n`;

  async function run(
    placement: string,
    restore?: unknown,
    overrides: Partial<AgentRunRequest> = {},
  ) {
    const request: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: "run",
      sourceMessageId: "source",
      prompt: "Continue",
      instructions: "",
      history: [{ role: "user", content: "Initial product history" }],
      tools: [],
      model: { provider: "pi-local", id: "default" },
      placement: { cwd: placement },
      session: {
        restore,
        save: async (value) => {
          saved = value as Record<string, unknown>;
        },
      },
      authorizeSubagentPlacement: async (placement) => ({
        placement: { cwd: placement.cwd ?? "." },
        executeTool: async () => {
          throw new Error("No tools expected");
        },
      }),
      ...overrides,
    };
    for await (const _event of runtime.run(request, { signal: AbortSignal.timeout(10_000) })) {
      /* Drain the run. */
    }
  }

  async function sessionFile(cwd: string) {
    const starts = (await readLocalPiEmulatorLog(cwd)).filter((item) => item.type === "start");
    const args = starts.at(-1)!.args as string[];
    return args[args.indexOf("--session") + 1]!;
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "rakazo-continuity-")));
    workspace = join(root, "workspace");
    target = join(workspace, "nested");
    await mkdir(target, { recursive: true });
    const command = await writeLocalPiEmulator(workspace);
    await writeLocalPiScenario(workspace, {});
    await writeLocalPiScenario(target, {});
    runtime = new LocalPiRuntime({ command, cwd: workspace, sessionDir: join(root, "sessions") });
    await run(".");
    oldFile = await sessionFile(workspace);
    await appendFile(oldFile, entry);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clones exact native entries with new ownership and never duplicates initial history", async () => {
    const previous = { ...saved };
    const oldBytes = await readFile(oldFile, "utf8");
    await run("nested", previous, { sourceMessageId: "next" });
    const nextFile = await sessionFile(target);
    expect(nextFile).not.toBe(oldFile);
    expect(await readFile(oldFile, "utf8")).toBe(oldBytes);
    const contents = await readFile(nextFile, "utf8");
    expect(contents.slice(contents.indexOf("\n") + 1)).toBe(entry);
    expect(JSON.parse(contents.split("\n")[0]!)).toMatchObject({
      cwd: target,
      id: saved.sessionId,
    });
    expect(saved.generation).not.toBe(previous.generation);
    expect(saved.cwdHash).not.toBe(previous.cwdHash);
    expect(
      JSON.parse(await readFile(nextFile.replace(/\.jsonl$/, ".owner.json"), "utf8")),
    ).toMatchObject({ cwdHash: saved.cwdHash, sessionId: saved.sessionId });
    const prompts = (await readLocalPiEmulatorLog(target)).filter(
      (item) =>
        item.type === "command" && (item.command as Record<string, unknown>).type === "prompt",
    );
    expect(JSON.stringify(prompts)).not.toContain("Initial product history");
    const current = { ...saved };
    await run("nested", current, { sourceMessageId: "third" });
    expect(await sessionFile(target)).toBe(nextFile);
    await run("nested", previous);
    expect(await sessionFile(target)).toBe(nextFile);
    await expect(run(".", previous)).rejects.toThrow(/ownership lock/);
  });

  it.each(["botId", "threadId"] as const)("refuses cross-%s adoption", async (key) => {
    await expect(run("nested", saved, { [key]: "other" })).rejects.toThrow(/ownership/);
    expect(await readLocalPiEmulatorLog(target)).toEqual([]);
  });

  it("refuses both stale and concurrent old ownership locks", async () => {
    const lock = oldFile.replace(/\.jsonl$/, ".lock");
    for (const parentPid of [99999999, process.pid]) {
      await writeFile(lock, JSON.stringify({ token: "other", parentPid }));
      await expect(run("nested", saved)).rejects.toThrow(/ownership lock/);
    }
  });

  it.each(["header", "owner", "truncated"])(
    "refuses corrupt %s without retiring the source",
    async (kind) => {
      if (kind === "truncated") await appendFile(oldFile, '{"type":');
      else {
        const path = kind === "owner" ? oldFile.replace(/\.jsonl$/, ".owner.json") : oldFile;
        const content = await readFile(path, "utf8");
        await writeFile(path, content.replace(String(saved.sessionId), "wrong-session"));
      }
      await expect(run("nested", saved)).rejects.toThrow();
      expect(await readLocalPiEmulatorLog(target)).toEqual([]);
      await expect(readFile(oldFile.replace(/\.jsonl$/, ".lock"))).rejects.toThrow();
    },
  );

  it.each(["session", "owner", "directory"])("refuses %s symlink adoption", async (kind) => {
    const path =
      kind === "directory"
        ? dirname(oldFile)
        : kind === "owner"
          ? oldFile.replace(/\.jsonl$/, ".owner.json")
          : oldFile;
    await rename(path, `${path}.actual`);
    await symlink(`${path}.actual`, path);
    await expect(run("nested", saved)).rejects.toThrow(/fence/);
  });

  it("refuses an old cwd outside the constructor root", async () => {
    const command = await writeLocalPiEmulator(target);
    runtime = new LocalPiRuntime({ command, cwd: target, sessionDir: join(root, "sessions") });
    await expect(run(".", saved)).rejects.toThrow();
    expect(await readLocalPiEmulatorLog(target)).toEqual([]);
  });

  it("refuses a previous cwd replaced by a symlink", async () => {
    await run("nested", saved, { sourceMessageId: "next" });
    const previous = { ...saved };
    await rename(target, `${target}.actual`);
    await symlink(`${target}.actual`, target);
    await expect(run(".", previous)).rejects.toThrow(/ownership cwd/);
  });

  it("refuses malformed pending outbox rather than silently filtering it", async () => {
    await expect(run("nested", { ...saved, outbox: [{ id: "missing-message" }] })).rejects.toThrow(
      /invalid pending outbox/,
    );
    await expect(readFile(oldFile.replace(/\.jsonl$/, ".lock"))).rejects.toThrow();
  });

  it("retries the published successor after checkpoint save fails", async () => {
    const previous = structuredClone(saved);
    const bytes = await readFile(oldFile, "utf8");
    await expect(
      run("nested", undefined, {
        session: {
          restore: previous,
          save: async () => {
            throw new Error("checkpoint unavailable");
          },
        },
      }),
    ).rejects.toThrow("checkpoint unavailable");
    const lock = oldFile.replace(/\.jsonl$/, ".lock");
    const retirementBytes = await readFile(lock, "utf8");
    const retirement = JSON.parse(retirementBytes);
    expect(retirement.successorCheckpoint.generation).toBe(retirement.successorGeneration);
    await run("nested", previous);
    expect(saved.generation).toBe(retirement.successorGeneration);
    expect(await readFile(oldFile, "utf8")).toBe(bytes);
    expect(await readFile(lock, "utf8")).toBe(retirementBytes);
  });

  it.each(["fake", "active", "cross-owner"])("rejects a %s successor", async (kind) => {
    const previous = structuredClone(saved);
    await run("nested", previous);
    const lock = oldFile.replace(/\.jsonl$/, ".lock");
    const retirement = JSON.parse(await readFile(lock, "utf8"));
    const nextFile = await sessionFile(target);
    if (kind === "active") {
      await writeFile(
        nextFile.replace(/\.jsonl$/, ".lock"),
        JSON.stringify({ token: "active", parentPid: process.pid }),
      );
    } else if (kind === "cross-owner") {
      retirement.successorCheckpoint.botHash = "other";
      await writeFile(lock, JSON.stringify(retirement));
    } else {
      retirement.token = "fabricated";
      await writeFile(lock, JSON.stringify(retirement));
    }
    await expect(run("nested", previous)).rejects.toThrow(/ownership lock/);
  });

  it("stamps legacy pending outbox with the previous cwd before replay", async () => {
    const checkpoints: Record<string, unknown>[] = [];
    await expect(
      run("nested", undefined, {
        session: {
          restore: {
            ...saved,
            outbox: [{ id: "legacy", messageId: "legacy-message", text: "Old intent" }],
          },
          save: async (value) => {
            checkpoints.push(structuredClone(value) as Record<string, unknown>);
          },
        },
      }),
    ).rejects.toThrow(/cwd requires a new run/);
    expect(checkpoints[0]?.outbox).toEqual([
      { id: "legacy", messageId: "legacy-message", text: "Old intent", placement: { cwd: "." } },
    ]);
    const prompts = (await readLocalPiEmulatorLog(target)).filter(
      (item) =>
        item.type === "command" && (item.command as Record<string, unknown>).type === "prompt",
    );
    expect(prompts).toEqual([]);
  });
  it("preserves pending outbox at the first migrated checkpoint", async () => {
    const outbox = [
      { id: "queued", messageId: "queued-message", text: "queued text", placement: { cwd: "." } },
    ];
    const checkpoints: Record<string, unknown>[] = [];
    await expect(
      run("nested", undefined, {
        session: {
          restore: { ...saved, outbox },
          save: async (value) => {
            checkpoints.push(structuredClone(value) as Record<string, unknown>);
          },
        },
      }),
    ).rejects.toThrow(/cwd requires a new run/);
    expect(
      checkpoints.some(
        (checkpoint) => JSON.stringify(checkpoint.outbox) === JSON.stringify(outbox),
      ),
    ).toBe(true);
    expect(await readFile(oldFile, "utf8")).toContain(entry);
  });
});
