import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, ProcessEvent } from "@rakazo/adapter-kit";
import { afterAll, describe, expect, it } from "vitest";
import { readComputerChanges } from "./project-services.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

// Real git in a temp repo, with hooks and config filters that must never run
// during a read-only review: a textconv filter, an external diff driver, and a
// filesystem-monitor hook, each leaving a marker file when executed.
const repo = mkdtempSync(join(tmpdir(), "rakazo-changes-"));
const markers = join(repo, "markers");
mkdirSync(markers);
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function git(argv: string[], cwd = repo): void {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${argv.join(" ")} failed: ${result.stderr}`);
}

const hostileScript = join(repo, "hostile.sh");
writeFileSync(hostileScript, '#!/bin/sh\ntouch "$MARKERS/hostile-$1"\nexit 1\n');
chmodSync(hostileScript, 0o755);

git(["init", "-q"]);
git(["config", "user.email", "test@rakazo.test"]);
git(["config", "user.name", "Test"]);
git(["config", "diff.hostile.textconv", `${hostileScript} textconv`]);
git(["config", "diff.external", `${hostileScript} extdiff`]);
git(["config", "core.fsmonitor", `${hostileScript} fsmonitor`]);
git(["config", "core.pager", `${hostileScript} pager`]);
writeFileSync(join(repo, ".gitattributes"), "*.txt diff=hostile\n");
writeFileSync(join(repo, "tracked.txt"), "original\n");
git(["add", "."]);
git(["commit", "-qm", "seed"]);
writeFileSync(join(repo, "tracked.txt"), "changed\n");

// Authorized sandbox exec shape: fixed argv, no shell, no inherited repo hooks.
const sandbox = {
  execute: async function* (
    _computer: unknown,
    request: { argv: string[]; cwd?: string },
  ): AsyncGenerator<ProcessEvent> {
    const result = spawnSync(request.argv[0] ?? "git", request.argv.slice(1), {
      cwd: request.cwd ?? repo,
      encoding: "utf8",
    });
    yield { type: "stdout", data: result.stdout };
    yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.status ?? 0 };
  },
} as never;

describe("readComputerChanges hostile hooks", () => {
  it("reports changes without executing textconv, external diff, fsmonitor, or pager hooks", async () => {
    const result = await readComputerChanges(
      sandbox,
      { id: "x" } as never,
      { cwd: repo, paths: [] },
      context,
    );
    expect(result.branch).toBe("main");
    expect(result.status).toContain(" M tracked.txt");
    expect(result.diff).toContain("+changed");
    expect(result.truncated).toBe(false);
    expect(existsSync(join(markers, "hostile-textconv"))).toBe(false);
    expect(existsSync(join(markers, "hostile-extdiff"))).toBe(false);
    expect(existsSync(join(markers, "hostile-fsmonitor"))).toBe(false);
    expect(existsSync(join(markers, "hostile-pager"))).toBe(false);
  });
});
