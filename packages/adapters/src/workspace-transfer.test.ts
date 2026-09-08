import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PortableFile } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentHomeStore } from "./home.js";
import {
  buildPortableManifest,
  copyAgentHome,
  manifestEntry,
  teamBotAreaFilter,
  verifyPortableManifest,
  WorkspaceTransferError,
} from "./workspace-transfer.js";

const context = {
  operationId: "workspace-transfer-test",
  traceId: "workspace-transfer-test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const enc = (text: string) => new TextEncoder().encode(text);

const file = (path: string, content: string, executable = false): PortableFile => ({
  path,
  content: enc(content),
  executable,
});

describe("verified workspace transfer", () => {
  it("hashes and verifies portable manifests", () => {
    const manifest = buildPortableManifest([file("a.txt", "one"), file("bin/run", "#!/sh", true)]);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[1]).toMatchObject({ executable: true, bytes: 5 });
    expect(() => verifyPortableManifest(manifest, manifest)).not.toThrow();

    const flipped = buildPortableManifest([file("bin/run", "#!/sh", false), file("a.txt", "one")]);
    expect(() => verifyPortableManifest(flipped, manifest)).toThrow(WorkspaceTransferError);

    const tampered = buildPortableManifest([file("a.txt", "ONE"), file("bin/run", "#!/sh", true)]);
    expect(() => verifyPortableManifest(tampered, manifest)).toThrow(WorkspaceTransferError);

    const missing = buildPortableManifest([file("a.txt", "one")]);
    expect(() => verifyPortableManifest(missing, manifest)).toThrow(/missing/);

    const extra = buildPortableManifest([
      file("a.txt", "one"),
      file("bin/run", "#!/sh", true),
      file("stowaway.txt", "x"),
    ]);
    expect(() => verifyPortableManifest(extra, manifest)).toThrow(/unexpected/);
    const duplicate = { entries: [...manifest.entries, manifest.entries[0]!] };
    expect(() => verifyPortableManifest(duplicate, manifest)).toThrow(/duplicate/);
    expect(() => verifyPortableManifest(manifest, duplicate)).toThrow(/duplicate/);
  });

  it("copies a real home with git, project directories, and executable bits, then verifies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-transfer-test-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    for (const f of [
      file(".git/HEAD", "ref: refs/heads/main"),
      file(".git/objects/ab/cdef", "blob"),
      file("projects/alpha/README.md", "alpha"),
      file("projects/beta/src/index.ts", "export {}"),
      file("scripts/build.sh", "#!/bin/sh\necho go\n", true),
      file("notes.txt", "hello"),
    ]) {
      await home.writeFile(
        "bot-1",
        f.path,
        f.content instanceof Uint8Array ? new TextDecoder().decode(f.content) : String(f.content),
        context,
      );
    }
    // Executable bits come from the store's own copy path; write raw via commit staging.
    const result = await copyAgentHome({ home, fromKey: "bot-1", toKey: "bot-1-copy", context });
    expect(result.manifest.entries.map((entry) => entry.path).sort()).toEqual([
      ".git/HEAD",
      ".git/objects/ab/cdef",
      "notes.txt",
      "projects/alpha/README.md",
      "projects/beta/src/index.ts",
      "scripts/build.sh",
    ]);
    expect(await home.readFile("bot-1-copy", "projects/beta/src/index.ts", context)).toBe(
      "export {}",
    );
    expect(result.revision).toBeTruthy();
  });

  it("preserves executable bits through the staging commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-transfer-exec-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const source = path.join(root, "seed");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(source, "bin"), { recursive: true });
    await writeFile(path.join(source, "bin", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(path.join(source, "plain.txt"), "x", { mode: 0o600 });
    const revision = await home.commit("bot-exec", source, context);
    expect(revision).toBeTruthy();

    const result = await copyAgentHome({
      home,
      fromKey: "bot-exec",
      toKey: "bot-exec-copy",
      context,
    });
    expect(result.manifest.entries).toEqual([
      { path: "bin/run.sh", bytes: 10, sha256: expect.any(String), executable: true },
      { path: "plain.txt", bytes: 1, sha256: expect.any(String), executable: false },
    ]);
    const copied = await stat(path.join(root, "homes", "bot-exec-copy", "bin", "run.sh"));
    expect(copied.mode & 0o100).toBeTruthy();
  });

  it("excludes transient browser state and honors a path filter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-transfer-skip-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    for (const f of [
      file(".browser-profiles/chromium/Cache/data", "junk"),
      file(".browser-profiles/chromium/SingletonLock", "junk"),
      file(".browser-profiles/chromium/Preferences", "keep"),
      file("bots/other-bot/secret.txt", "foreign"),
      file("shared/team-notes.md", "shared"),
      file("bots/me/work.md", "mine"),
    ]) {
      await home.writeFile("team-space", f.path, new TextDecoder().decode(f.content), context);
    }
    const result = await copyAgentHome({
      home,
      fromKey: "team-space",
      toKey: "machine-copy",
      context,
      filter: teamBotAreaFilter("me"),
    });
    // Only the bot's own area and shared survive; the team computer's shared
    // browser profile and other bots' areas stay behind.
    expect(result.manifest.entries.map((entry) => entry.path).sort()).toEqual([
      "bots/me/work.md",
      "shared/team-notes.md",
    ]);
    expect(result.manifest.entries.some((entry) => entry.path.includes("other-bot"))).toBe(false);
    expect(result.manifest.entries.some((entry) => entry.path.includes("browser-profiles"))).toBe(
      false,
    );
  });

  it("detects a tampered durable copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-transfer-tamper-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    await home.writeFile("src", "a.txt", "original", context);
    const { entries } = { entries: [manifestEntry(file("a.txt", "original"))] };
    await home.writeFile("dst", "a.txt", "tampered", context);
    expect(() =>
      verifyPortableManifest(buildPortableManifest([file("a.txt", "tampered")]), {
        entries,
      }),
    ).toThrow(WorkspaceTransferError);
  });
});
