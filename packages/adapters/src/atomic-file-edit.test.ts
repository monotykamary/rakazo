import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AtomicFileEditInput, atomicFileEdit } from "./atomic-file-edit.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { createBrokerCall, type ManagedResult, managedCoreTools } from "./pi-managed-tools.js";
import { bindPlacementExecutor } from "./pi-placement.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(content: string | Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "atomic-edit-test-"));
  roots.push(root);
  const path = join(root, "source.txt");
  await writeFile(path, content);
  return { root, path };
}
// Fake-only local sandbox transport: execute the exact production argv, not a duplicate algorithm.
const execute = (argv: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const input = JSON.parse(Buffer.from(argv.at(-1)!, "base64").toString()) as AtomicFileEditInput;
    execFile(
      argv[0]!,
      argv.slice(1),
      { timeout: 10000, cwd: dirname(input.path) },
      (error, stdout, stderr) => {
        resolve({ code: error ? 1 : 0, stdout, stderr });
      },
    );
  });
const editTool = builtinAgentTools.find((tool) => tool.name === "edit_file")!;
function bridgeFixture(path: string, override?: AgentRunRequest["executeTool"]) {
  const calls: string[] = [];
  const events: AgentRuntimeEvent[] = [];
  const request: AgentRunRequest = {
    runId: "parent",
    botId: "bot",
    threadId: "thread",
    prompt: "Edit",
    instructions: "Edit",
    history: [],
    tools: [editTool],
    model: { provider: "offline", id: "offline" },
    executeTool:
      override ??
      (async (name, args) => {
        calls.push(name);
        expect(name).toBe("edit_file");
        return atomicFileEdit({ ...args, path } as AtomicFileEditInput, execute);
      }),
  };
  const authority = new RunAuthority(request, new AbortController().signal);
  const core = (run: AgentRunRequest) => {
    const bridge = new ToolBridge(run, authority, (event) => events.push(event));
    const proxy: ToolDefinition = {
      name: "edit_file",
      label: "edit",
      description: editTool.description,
      parameters: bridge.catalog[0]!.parameters as ToolDefinition["parameters"],
      execute: async (id, args) =>
        (
          (await bridge.invoke({ handle: bridge.catalog[0]!.handle, callId: id, args })) as {
            result: ManagedResult;
          }
        ).result,
    };
    const tool = managedCoreTools(createBrokerCall([proxy], () => authority.paused)).find(
      (tool) => tool.name === "edit",
    )!;
    return (edits: AtomicFileEditInput["edits"]) =>
      tool.execute(
        randomUUID(),
        { path: "source.txt", edits },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
  };
  return {
    parent: core(request),
    child: core({ ...request, runId: "child" }),
    authority,
    calls,
    events,
  };
}

describe("authorized atomic file edit", () => {
  it("sends one managed operation per parent/child edit and keeps fake credentials and raw UTF-8 bytes untouched", async () => {
    const secret = "fake-only-token-NEVER-RETURN";
    const original = `\ufeffkey=${secret}\r\na=old\r\nb=old\r\nemoji=🦊`;
    const { path } = await fixture(original);
    await chmod(path, 0o640);
    const bridge = bridgeFixture(path);
    const results = await Promise.all([
      bridge.parent([{ oldText: "a=old", newText: "a=new" }]),
      bridge.child([{ oldText: "b=old", newText: "b=new" }]),
    ]);
    expect(bridge.calls).toEqual(["edit_file", "edit_file"]);
    expect(await readFile(path)).toEqual(
      Buffer.from(original.replace("a=old", "a=new").replace("b=old", "b=new")),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(JSON.stringify({ results, events: bridge.events })).not.toContain(secret);
    expect(results.every((result) => JSON.stringify(result).includes('"ok":true'))).toBe(true);
  });

  it("shares the canonical file lock across separate backend processes and symlink aliases", async () => {
    const count = 12;
    const original = Array.from({ length: count }, (_, i) => `line-${i}=old`).join("\n");
    const { root, path } = await fixture(original);
    const alias = join(root, "alias.txt");
    await symlink(path, alias);
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        atomicFileEdit(
          {
            path: i % 2 ? alias : path,
            edits: [{ oldText: `line-${i}=old`, newText: `line-${i}=new` }],
          },
          execute,
        ),
      ),
    );
    expect(results).toEqual(Array.from({ length: count }, () => ({ ok: true })));
    expect(await readFile(path, "utf8")).toBe(original.replaceAll("=old", "=new"));
  });

  it.each([
    [
      { oldText: "a=old", newText: "a=new" },
      { oldText: "missing", newText: "bad" },
    ],
    [{ oldText: "old", newText: "new" }],
    [
      { oldText: "a=old", newText: "new" },
      { oldText: "a=", newText: "bad" },
    ],
    [{ oldText: "", newText: "bad" }],
  ])("does not partially write invalid edit batches %#", async (...edits) => {
    const original = "fake-secret=untouched\na=old\nb=old\n";
    const { root, path } = await fixture(original);
    expect(await atomicFileEdit({ path, edits }, execute)).toHaveProperty("error");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(root)).toEqual(["source.txt"]);
  });

  it("applies every anchor to the original snapshot and supports explicit all", async () => {
    const { path } = await fixture("a=old\nb=old\n");
    expect(
      await atomicFileEdit(
        { path, edits: [{ oldText: "old", newText: "new", all: true }] },
        execute,
      ),
    ).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("a=new\nb=new\n");
    expect(
      await atomicFileEdit(
        {
          path,
          edits: [
            { oldText: "a=new", newText: "c=new" },
            { oldText: "c=new", newText: "d=new" },
          ],
        },
        execute,
      ),
    ).toHaveProperty("error");
    expect(await readFile(path, "utf8")).toBe("a=new\nb=new\n");
  });

  it("rejects ambiguous overlapping occurrences, non-UTF8 and hardlinks without changing bytes", async () => {
    for (const content of [Buffer.from("aaa"), Buffer.from([0xff, 0x61])]) {
      const { path } = await fixture(content);
      expect(
        await atomicFileEdit({ path, edits: [{ oldText: "aa", newText: "b" }] }, execute),
      ).toHaveProperty("error");
      expect(await readFile(path)).toEqual(content);
    }
    const { root, path } = await fixture("a=old");
    await link(path, join(root, "hardlink"));
    expect(
      await atomicFileEdit({ path, edits: [{ oldText: "old", newText: "new" }] }, execute),
    ).toHaveProperty("error");
    expect(await readFile(path, "utf8")).toBe("a=old");
  });

  it.each(["os.fsync(output.fileno())", "os.replace(temporary, target)"])(
    "leaves the original intact when %s fails",
    async (operation) => {
      const original = "secret=fake-only-untouched\na=old";
      const { root, path } = await fixture(original);
      const result = await atomicFileEdit(
        { path, edits: [{ oldText: "a=old", newText: "a=new" }] },
        (argv) => {
          // Inject an OS failure into the exact backend program at the commit boundary.
          const injected = [...argv];
          expect(injected[3]).toContain(operation);
          injected[3] = injected[3]!.replace(
            operation,
            "(_ for _ in ()).throw(OSError('fake-only-secret-error'))",
          );
          return execute(injected);
        },
      );
      expect(result).toHaveProperty("error");
      expect(JSON.stringify(result)).not.toContain("fake-only");
      expect(await readFile(path, "utf8")).toBe(original);
      expect(await readdir(root)).toEqual(["source.txt"]);
    },
  );

  it("detects an uncooperative source change before commit without overwriting it", async () => {
    const { root, path } = await fixture("a=old\nb=old");
    const result = await atomicFileEdit(
      { path, edits: [{ oldText: "a=old", newText: "a=new" }] },
      (argv) => {
        const injected = [...argv];
        injected[3] = injected[3]!.replace(
          "os.fsync(output.fileno())",
          "os.fsync(output.fileno())\n                with open(target, 'wb') as other:\n                    other.write(b'a=old\\nb=external')",
        );
        return execute(injected);
      },
    );
    expect(result).toHaveProperty("error");
    expect(await readFile(path, "utf8")).toBe("a=old\nb=external");
    expect(await readdir(root)).toEqual(["source.txt"]);
  });

  it("rejects symlink escapes and oversized source or replacement without mutation", async () => {
    const outside = await fixture("a=old");
    const inside = await fixture("placeholder");
    const alias = join(inside.root, "escape");
    await symlink(outside.path, alias);
    expect(
      await atomicFileEdit({ path: alias, edits: [{ oldText: "old", newText: "new" }] }, execute),
    ).toHaveProperty("error");
    expect(await readFile(outside.path, "utf8")).toBe("a=old");
    const large = "a".repeat(250001);
    await writeFile(inside.path, large);
    expect(
      await atomicFileEdit(
        { path: inside.path, edits: [{ oldText: "a", newText: "b", all: true }] },
        execute,
      ),
    ).toHaveProperty("error");
    expect(await readFile(inside.path, "utf8")).toBe(large);
    await writeFile(inside.path, "a".repeat(10000));
    expect(
      await atomicFileEdit(
        { path: inside.path, edits: [{ oldText: "a", newText: "b".repeat(30), all: true }] },
        execute,
      ),
    ).toHaveProperty("error");
    expect(await readFile(inside.path, "utf8")).toBe("a".repeat(10000));
  });

  it("surfaces a failed backend edit as managed failure, not success", async () => {
    const { path } = await fixture("fake-secret=untouched\na=old");
    const bridge = bridgeFixture(path);
    await expect(bridge.parent([{ oldText: "missing", newText: "new" }])).rejects.toThrow(
      "Authorized computer operation failed",
    );
    expect(await readFile(path, "utf8")).toBe("fake-secret=untouched\na=old");
  });

  it("never exposes provider diagnostics, missing primitives, or file contents on failure", async () => {
    const input = { path: "fake-secret-path", edits: [{ oldText: "old", newText: "new" }] };
    for (const run of [
      async () => ({ code: 127, stdout: "fake-secret-stdout", stderr: "fake-secret-stderr" }),
      async () => {
        throw new Error("fake-secret-provider-error");
      },
    ]) {
      const result = await atomicFileEdit(input, run);
      expect(result).toHaveProperty("error");
      expect(JSON.stringify(result)).not.toContain("fake-secret");
    }
  });

  it("fails closed without edit_file authority rather than falling back to read/write", async () => {
    const call = vi.fn();
    const tool = managedCoreTools(createBrokerCall([], () => false)).find(
      (tool) => tool.name === "edit",
    )!;
    await expect(
      tool.execute(
        "denied",
        { path: "file", edits: [{ oldText: "old", newText: "new" }] },
        undefined,
        call,
        {} as ExtensionContext,
      ),
    ).rejects.toThrow("capability unavailable: edit_file");
    expect(call).not.toHaveBeenCalled();
  });

  it("shares the approval pause latch and prevents queued child effects", async () => {
    const executor = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [{ type: "text", text: "Approval required" }],
      details: { approval: "paused" },
      terminate: true,
    }));
    const bridge = bridgeFixture("unused", executor);
    const results = await Promise.allSettled([
      bridge.parent([{ oldText: "a", newText: "b" }]),
      bridge.child([{ oldText: "c", newText: "d" }]),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(executor).toHaveBeenCalledOnce();
    expect(bridge.authority.paused).toBe(true);
  });

  it("registers the real schema, validates it in ToolBridge and binds child placement", async () => {
    expect(editTool.inputSchema).toMatchObject({ required: ["path", "edits"] });
    const executor = vi.fn(async () => ({ ok: true }));
    const bridge = bridgeFixture("unused", executor);
    await expect(bridge.parent([])).rejects.toThrow();
    expect(executor).not.toHaveBeenCalled();
    const placed = bindPlacementExecutor("worktrees/child", executor);
    await placed(
      "edit_file",
      { path: "source.txt", edits: [{ oldText: "old", newText: "new" }] },
      "effect",
    );
    expect(executor).toHaveBeenCalledWith(
      "edit_file",
      expect.objectContaining({ path: "worktrees/child/source.txt" }),
      "effect",
      undefined,
      undefined,
    );
    expect(() => placed("edit_file", { path: "../escape" }, "effect")).toThrow("placement");
  });
});
