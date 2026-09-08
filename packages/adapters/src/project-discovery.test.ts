import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedDiscoveryRoots,
  buildProjectDiscoveryCommand,
  DEFAULT_PROJECT_DISCOVERY_LIMITS,
  discoveredProjectName,
  discoveryRootsForDirectory,
  parseProjectDiscoveryOutput,
  resolveProjectReference,
  sanitizeGitRemoteUrl,
} from "./project-discovery.js";

describe("sanitizeGitRemoteUrl", () => {
  it("drops embedded credentials from network remotes", () => {
    expect(sanitizeGitRemoteUrl("https://user:token@example.com/acme/app.git")).toBe(
      "https://example.com/acme/app.git",
    );
    expect(sanitizeGitRemoteUrl("https://token@example.com/acme/app.git")).toBe(
      "https://example.com/acme/app.git",
    );
    expect(sanitizeGitRemoteUrl("ssh://git@example.com/acme/app.git")).toBe(
      "ssh://example.com/acme/app.git",
    );
    expect(sanitizeGitRemoteUrl("git@example.com:acme/app.git")).toBe("example.com:acme/app.git");
    expect(sanitizeGitRemoteUrl("https://example.com/acme/app.git")).toBe(
      "https://example.com/acme/app.git",
    );
  });

  it("strips query strings and fragments that can carry credentials", () => {
    expect(sanitizeGitRemoteUrl("https://example.com/acme/app.git?token=secret")).toBe(
      "https://example.com/acme/app.git",
    );
    expect(sanitizeGitRemoteUrl("https://example.com/acme/app.git#fragment")).toBe(
      "https://example.com/acme/app.git",
    );
    expect(sanitizeGitRemoteUrl("https://example.com/acme/app.git?token=secret#f")).toBe(
      "https://example.com/acme/app.git",
    );
  });

  it("never surfaces local or unrepresentable remotes", () => {
    expect(sanitizeGitRemoteUrl("/srv/git/app.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("file:///srv/git/app.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("../app.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("")).toBeNull();
    expect(sanitizeGitRemoteUrl("https://example.com/a b.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("git@example.com:" + "x".repeat(600))).toBeNull();
  });
});

describe("parseProjectDiscoveryOutput", () => {
  it("parses repository lines into sanitized project refs", () => {
    const { projects, truncated } = parseProjectDiscoveryOutput(
      [
        "./app\tgit@github.com:acme/app.git\tmain",
        "./shared/tools\t\t",
        ".\thttps://u:p@example.com/acme/root.git\trelease-1",
        "",
      ].join("\n"),
    );
    expect(truncated).toBe(false);
    expect(projects).toEqual([
      { path: "app", name: "app", remote: "github.com:acme/app.git", branch: "main" },
      { path: "shared/tools", name: "tools", remote: null, branch: null },
      { path: ".", name: ".", remote: "https://example.com/acme/root.git", branch: "release-1" },
    ]);
  });

  it("reports truncated coverage through the marker and the project cap", () => {
    const marker = "RAKAZO_PROJECT_DISCOVERY_TRUNCATED\t\t";
    const withMarker = parseProjectDiscoveryOutput("./a/.git\t\t\n" + marker);
    expect(withMarker.truncated).toBe(true);
    expect(withMarker.projects).toHaveLength(1);
    const lines = Array.from(
      { length: DEFAULT_PROJECT_DISCOVERY_LIMITS.maxProjects + 3 },
      (_, i) => "./r" + i + "/.git\t\t",
    );
    const capped = parseProjectDiscoveryOutput(lines.join("\n"));
    expect(capped.projects).toHaveLength(DEFAULT_PROJECT_DISCOVERY_LIMITS.maxProjects);
    expect(capped.truncated).toBe(true);
  });

  it("skips paths that would escape the workspace", () => {
    const { projects } = parseProjectDiscoveryOutput(
      ["../outside\t\t", "./ok\t\t", "./bad\0\t\t"].join("\n"),
    );
    expect(projects.map((p) => p.path)).toEqual(["ok"]);
  });
});

describe("resolveProjectReference", () => {
  const projects = [
    { path: "app", name: "app", remote: "github.com:acme/app.git", branch: "main" },
    { path: "shared/tools", name: "tools", remote: null, branch: null },
    { path: "legacy/Tools", name: "Tools", remote: null, branch: null },
  ];

  it("resolves exact paths first", () => {
    expect(resolveProjectReference(projects, "shared/tools")).toEqual({
      kind: "resolved",
      project: projects[1],
    });
    expect(resolveProjectReference(projects, "./app/")).toEqual({
      kind: "resolved",
      project: projects[0],
    });
  });

  it("resolves one repo across https and scp remote forms", () => {
    expect(resolveProjectReference(projects, "ssh://git@github.com/acme/app.git").kind).toBe(
      "resolved",
    );
  });

  it("resolves by sanitized remote", () => {
    expect(
      resolveProjectReference(projects, "https://token:secret@github.com/acme/app.git").kind,
    ).toBe("resolved");
  });

  it("reports ambiguity instead of guessing", () => {
    const resolution = resolveProjectReference(projects, "tools");
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous")
      expect(resolution.candidates.map((p) => p.path)).toEqual(["shared/tools", "legacy/Tools"]);
  });

  it("reports missing references", () => {
    expect(resolveProjectReference(projects, "nope").kind).toBe("missing");
    expect(resolveProjectReference(projects, "  ").kind).toBe("missing");
  });
});

describe("approvedDiscoveryRoots and the scan command", () => {
  it("narrows incrementally without admitting other bot areas or absolute paths", () => {
    expect(discoveryRootsForDirectory("dedicated", "bot1", "projects/app")).toEqual([
      "projects/app",
    ]);
    expect(discoveryRootsForDirectory("team", "bot1", "shared/app")).toEqual(["shared/app"]);
    expect(discoveryRootsForDirectory("team", "bot1", "bots/bot1/app")).toEqual(["bots/bot1/app"]);
    for (const directory of [
      ".",
      "bots/bot2",
      "bots/bot10",
      "shared/../bots/bot2",
      "/outside",
      "shared\\outside",
    ]) {
      expect(() => discoveryRootsForDirectory("team", "bot1", directory)).toThrow();
    }
  });
  it("bounds team discovery to the bot area and shared, private to the workspace root", () => {
    expect(approvedDiscoveryRoots("dedicated", "bot1")).toEqual(["."]);
    expect(approvedDiscoveryRoots("team", "bot1")).toEqual(["bots/bot1", "shared"]);
  });

  it("builds a bounded read-only scan", () => {
    const command = buildProjectDiscoveryCommand({ maxDepth: 3, maxProjects: 8 });
    expect(command).toContain("-maxdepth 3");
    expect(command).toContain("-name .git");
    expect(command).toContain("-prune");
    expect(command).toContain("RAKAZO_PROJECT_DISCOVERY_TRUNCATED");
    expect(command).not.toContain("eval");
  });

  it("never executes git inside scanned repositories", () => {
    const command = buildProjectDiscoveryCommand(DEFAULT_PROJECT_DISCOVERY_LIMITS);
    expect(command).not.toContain("git -C");
    expect(command).not.toContain("git config");
    expect(command).not.toContain("rev-parse");
  });
});

const shellScanAvailable = (() => {
  try {
    execFileSync("bash", ["-c", "command -v git >/dev/null"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

(shellScanAvailable ? describe : describe.skip)(
  "buildProjectDiscoveryCommand against a real workspace",
  () => {
    let root: string;
    let outside: string;
    let git: (cwd: string, ...args: string[]) => void;

    beforeAll(() => {
      root = mkdtempSync(path.join(tmpdir(), "rakazo-discovery-"));
      outside = mkdtempSync(path.join(tmpdir(), "rakazo-discovery-outside-"));
      git = (cwd, ...args) =>
        execFileSync(
          "git",
          ["-c", "user.email=scan@example.invalid", "-c", "user.name=scan", ...args],
          {
            cwd,
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
          },
        );
      // A repo outside every approved root, with credentials in its remote.
      const victim = path.join(outside, "victim");
      mkdirSync(victim);
      git(victim, "init", "-b", "main");
      git(victim, "commit", "--allow-empty", "-m", "init");
      git(victim, "remote", "add", "origin", "https://victim:secret@outside.invalid/victim.git");
      // Inside repo with a credential-bearing remote query.
      const repo1 = path.join(root, "repo1");
      mkdirSync(repo1);
      git(repo1, "init", "-b", "main");
      git(repo1, "commit", "--allow-empty", "-m", "init");
      git(repo1, "remote", "add", "origin", "https://example.invalid/me/proj.git?token=leakme");
      // Inside repo whose config includes the outside repo's config.
      const repo2 = path.join(root, "repo2");
      mkdirSync(repo2);
      git(repo2, "init", "-b", "main");
      git(repo2, "commit", "--allow-empty", "-m", "init");
      writeFileSync(
        path.join(repo2, ".git", "config"),
        "[include]\n\tpath = " + victim + "/.git/config\n",
        {
          flag: "a",
        },
      );
      // A .git file pointing at the outside repo (cross-root gitdir pointer).
      const fake = path.join(root, "fake");
      mkdirSync(fake);
      writeFileSync(path.join(fake, ".git"), "gitdir: " + victim + "/.git\n");
      // A symlinked .git pointing outside the root.
      const sym = path.join(root, "sym");
      mkdirSync(sym);
      symlinkSync(path.join(victim, ".git"), path.join(sym, ".git"));
      // A real linked worktree of repo1 inside the root.
      git(repo1, "worktree", "add", path.join(root, "wt1"));
      // Heavy untracked directories are pruned and never reported.
      const heavy = path.join(root, "node_modules", "pkg");
      mkdirSync(heavy, { recursive: true });
      git(heavy, "init", "-b", "main");
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    const scan = (limits = { maxDepth: 4, maxProjects: 16 }) =>
      parseProjectDiscoveryOutput(
        execFileSync("bash", ["-c", buildProjectDiscoveryCommand(limits)], {
          cwd: root,
          encoding: "utf8",
        }),
        limits,
      );

    const byPath = (limits?: { maxDepth: number; maxProjects: number }) =>
      new Map(scan(limits).projects.map((p) => [p.path, p]));

    it("stops at its entry budget even when a wide tree contains no repositories", () => {
      const wide = mkdtempSync(path.join(tmpdir(), "rakazo-discovery-budget-"));
      try {
        for (let index = 0; index < 500; index++) mkdirSync(path.join(wide, `empty-${index}`));
        const limits = { maxDepth: 4, maxProjects: 16, maxEntries: 8 };
        const stdout = execFileSync("bash", ["-c", buildProjectDiscoveryCommand(limits)], {
          cwd: wide,
          encoding: "utf8",
          timeout: 5000,
        });
        expect(parseProjectDiscoveryOutput(stdout, limits)).toEqual({
          projects: [],
          truncated: true,
        });
      } finally {
        rmSync(wide, { recursive: true, force: true });
      }
    });

    it("marks depth coverage partial so a caller can narrow to a deeper directory", () => {
      const stdout = execFileSync(
        "bash",
        ["-c", buildProjectDiscoveryCommand({ maxDepth: 1, maxProjects: 16 })],
        { cwd: root, encoding: "utf8" },
      );
      expect(parseProjectDiscoveryOutput(stdout).truncated).toBe(true);
    });

    it("finds repositories inside the root with sanitized remotes and branches", () => {
      const { truncated } = scan();
      expect(truncated).toBe(false);
      expect(byPath().get("repo1")).toEqual({
        path: "repo1",
        name: "repo1",
        remote: "https://example.invalid/me/proj.git",
        branch: "main",
      });
    });

    it("ignores config include directives instead of following them", () => {
      const repo2 = byPath().get("repo2");
      expect(repo2).toBeDefined();
      expect(repo2!.remote).toBeNull();
      expect(repo2!.branch).toBe("main");
    });

    it("reports cross-root .git pointers and symlinked .git with null metadata", () => {
      const paths = byPath();
      for (const key of ["fake", "sym"]) {
        const entry = paths.get(key);
        expect(entry).toBeDefined();
        expect(entry!.remote).toBeNull();
        expect(entry!.branch).toBeNull();
      }
    });

    it("reports linked worktrees as paths with null metadata", () => {
      const wt1 = byPath().get("wt1");
      expect(wt1).toBeDefined();
      expect(wt1!.remote).toBeNull();
      expect(wt1!.branch).toBeNull();
    });

    it("never surfaces paths outside the root or pruned directories", () => {
      expect(
        scan()
          .projects.map((p) => p.path)
          .sort(),
      ).toEqual(["fake", "repo1", "repo2", "sym", "wt1"]);
    });

    it("emits the truncation marker past the repository cap", () => {
      const { projects, truncated } = scan({ maxDepth: 2, maxProjects: 2 });
      expect(projects).toHaveLength(2);
      expect(truncated).toBe(true);
    });
  },
);

describe("discoveredProjectName", () => {
  it("uses the directory basename and keeps the root anonymous", () => {
    expect(discoveredProjectName("shared/tools")).toBe("tools");
    expect(discoveredProjectName(".")).toBe(".");
  });
});
