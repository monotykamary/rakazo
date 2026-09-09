import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import {
  assertLocalPiRunAllowed,
  authorizeLocalPiPlacement,
  createRunExecutor,
  isDurablePiRuntime,
} from "./executor.js";

function runtime(id: string): AgentRuntime {
  return {
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "test",
      capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
    }),
    run: vi.fn(),
    abort: vi.fn(),
  } as unknown as AgentRuntime;
}

function localDeps(
  input: {
    ownerUserId?: string | null;
    temporary?: boolean;
    machineId?: string | null;
    sandboxId?: string;
  } = {},
) {
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: input.ownerUserId ?? "owner" })),
    },
    bot: {
      findFirst: vi.fn(async () => ({
        temporary: input.temporary ?? false,
        computer: { machineId: input.machineId ?? null },
      })),
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    runtime: runtime("pi-local"),
    sandbox: {
      describe: () => ({ id: input.sandboxId ?? "desktop", capabilities: {} }),
    },
    localPiCwd: "/tmp/rakazo-local-pi",
  } as unknown as Parameters<typeof assertLocalPiRunAllowed>[0];
}

const run = { userId: "owner", spaceId: "space", botId: "bot" };

describe("native placement desktop integration", () => {
  it("authorizes root-relative projects, worktrees and Team subdirs and binds real file callbacks", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-placement-")));
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-outside-")));
    const context = {
      operationId: "placement",
      traceId: "trace",
      spaceId: "space",
      userId: "owner",
      signal: new AbortController().signal,
    };
    try {
      const desktop = new DesktopSandboxProvider({ trustedWorkspaceRoot: root });
      const computer = await desktop.provision({ botId: "bot", homePath: "/unused" }, context);
      const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async (name, args) => {
        const file = String(args.path ?? ".");
        if (name === "list_files")
          return { entries: await desktop.listFiles(computer, file === "." ? "" : file, context) };
        if (name === "write_file") {
          await desktop.writeFile(computer, {
            path: file,
            content: new TextEncoder().encode(String(args.content)),
          });
          return { ok: true };
        }
        if (name === "read_file")
          return new TextDecoder().decode(await desktop.readFile(computer, file));
        throw new Error("Unexpected tool");
      });
      const authorize: NonNullable<AgentRunRequest["authorizeSubagentPlacement"]> = (placement) =>
        authorizeLocalPiPlacement(root, computer, placement, execute, "run");
      for (const cwd of [
        "projects/app",
        "worktrees/feature",
        "bots/bot/project",
        "shared/project",
        ".",
      ]) {
        await mkdir(path.join(root, cwd), { recursive: true });
        const authorized = await authorize({ cwd, worktreeId: cwd }, "run");
        expect(authorized.placement).toEqual({ cwd, worktreeId: cwd });
        expect(execute).toHaveBeenLastCalledWith(
          "list_files",
          { path: cwd },
          `run:placement:${cwd}`,
        );
        await authorized.executeTool!("write_file", { path: "result.txt", content: cwd }, "write");
        expect(await readFile(path.join(root, cwd, "result.txt"), "utf8")).toBe(cwd);
        expect(await authorized.executeTool!("read_file", { path: "result.txt" }, "read")).toBe(
          cwd,
        );
        await expect(async () =>
          authorized.executeTool!("write_file", { path: "../escape.txt", content: "no" }, "escape"),
        ).rejects.toThrow();
      }
      expect((await authorize({ cwd: path.join(root, "projects/app") }, "run")).placement.cwd).toBe(
        "projects/app",
      );
      await symlink(path.join(root, "projects/app"), path.join(root, "alias"), "dir");
      expect((await authorize({ cwd: "alias" }, "run")).placement.cwd).toBe("projects/app");
      const selected = await authorize({ cwd: "projects/app" }, "run");
      await writeFile(path.join(outside, "private.txt"), "unchanged");
      await symlink(outside, path.join(root, "projects/app/outside"), "dir");
      await expect(
        selected.executeTool("read_file", { path: "outside/private.txt" }, "read-escape"),
      ).rejects.toThrow();
      await expect(
        selected.executeTool(
          "write_file",
          { path: "outside/private.txt", content: "changed" },
          "write-escape",
        ),
      ).rejects.toThrow();
      expect(await readFile(path.join(outside, "private.txt"), "utf8")).toBe("unchanged");
      await rm(path.join(root, "projects/app/outside"));
      await symlink(outside, path.join(root, "escape"), "dir");
      await writeFile(path.join(root, "plain.txt"), "file");
      for (const cwd of [
        outside,
        "../outside",
        "projects/../worktrees",
        "escape",
        "missing",
        "plain.txt",
        "C:/outside",
        "bad\\path",
      ]) {
        execute.mockClear();
        await expect(authorize({ cwd }, "run")).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
      }
      await expect(
        authorizeLocalPiPlacement(
          root,
          { ...computer, providerRef: outside },
          { cwd: "projects/app" },
          execute,
          "run",
        ),
      ).rejects.toThrow("does not match");
      const denied = vi.fn(async () => ({ error: "lease lost" }));
      await expect(
        authorizeLocalPiPlacement(root, computer, { cwd: "projects/app" }, denied, "run"),
      ).rejects.toThrow("could not be authorized");
    } finally {
      await Promise.all(
        [root, outside].map((directory) => rm(directory, { recursive: true, force: true })),
      );
    }
  });
});

describe("local Pi execution authority", () => {
  it.each(["user", "routine", "bot_message"])(
    "rejects a non-owner %s run before leasing or host effects",
    async (trigger) => {
      const updateMany = vi.fn();
      const runtimeAdapter = runtime("pi-local");
      const sandboxProvision = vi.fn();
      const prisma = {
        run: {
          findUnique: vi.fn(async () => ({
            ...run,
            userId: "other-user",
            status: "queued",
            trigger,
            leaseFence: 0,
          })),
          updateMany,
        },
        deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
        bot: {
          findFirst: vi.fn(async () => ({ temporary: false, computer: { machineId: null } })),
        },
      };
      const executor = createRunExecutor({
        prisma,
        runtime: runtimeAdapter,
        sandbox: {
          describe: () => ({ id: "desktop", capabilities: {} }),
          provision: sandboxProvision,
        },
        localPiCwd: "/tmp/rakazo-local-pi",
        web: {},
        browser: {},
      } as unknown as Parameters<typeof createRunExecutor>[0]);

      await expect(executor.continueRun("run", "worker")).rejects.toThrow(
        "only to the deployment owner",
      );
      expect(updateMany).not.toHaveBeenCalled();
      expect(sandboxProvision).not.toHaveBeenCalled();
      expect(runtimeAdapter.run).not.toHaveBeenCalled();
    },
  );

  it("allows only owner-scoped, backend-local, non-temporary bots on desktop", async () => {
    await expect(assertLocalPiRunAllowed(localDeps(), run)).resolves.toBeUndefined();
    await expect(assertLocalPiRunAllowed(localDeps({ temporary: true }), run)).rejects.toThrow(
      "dispatched temporary work",
    );
    await expect(
      assertLocalPiRunAllowed(localDeps({ machineId: "remote-machine" }), run),
    ).rejects.toThrow("remote machine assignment");
    for (const trigger of ["webhook", "messaging", "bot_message", "cloud_agent"]) {
      await expect(assertLocalPiRunAllowed(localDeps(), { ...run, trigger })).rejects.toThrow(
        "externally triggered work",
      );
    }
    await expect(assertLocalPiRunAllowed(localDeps({ sandboxId: "docker" }), run)).rejects.toThrow(
      "native desktop sandbox provider",
    );
  });

  it("preserves durable Pi session/queue behavior for local Pi", () => {
    expect(isDurablePiRuntime(runtime("pi"))).toBe(true);
    expect(isDurablePiRuntime(runtime("pi-local"))).toBe(true);
    expect(isDurablePiRuntime(runtime("scripted"))).toBe(false);
  });

  it("resolves the synthetic Pi default without a Rakazo credential or API key", async () => {
    const prisma = {
      bot: {
        findFirst: vi.fn(async (args: { select?: { temporary?: boolean } }) =>
          args.select?.temporary ? { temporary: false, computer: { machineId: null } } : null,
        ),
      },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async (args: { select?: { ownerUserId?: boolean } }) =>
          args.select?.ownerUserId ? { ownerUserId: "owner" } : null,
        ),
      },
      user: { findUnique: vi.fn(async () => ({ modelVisibility: { hide: [] } })) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
    };
    const executor = createRunExecutor({
      prisma,
      runtime: runtime("pi-local"),
      sandbox: { describe: () => ({ id: "desktop", capabilities: {} }) },
      localPiCwd: "/tmp/rakazo-local-pi",
      web: {},
      browser: {},
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await expect(
      executor.resolveModel({ userId: "owner", spaceId: "space", botId: "bot" }),
    ).resolves.toEqual({
      provider: "pi-local",
      id: "default",
      apiKey: "",
      thinkingLevel: undefined,
    });
  });
});
