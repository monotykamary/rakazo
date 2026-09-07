import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type BrokerCall, resultValue, textResult } from "./pi-managed-tools.js";

interface GraphResult {
  text: string;
  details: Record<string, unknown>;
}
interface GraphOps {
  sketch(root: string, budget?: number): Promise<GraphResult>;
  focus(root: string, query: string, budget?: number): Promise<GraphResult>;
  dwell(root: string, factor?: number, budget?: number): Promise<GraphResult>;
  impact(root: string, args: { files?: string[]; budget?: number }): Promise<GraphResult>;
  evictState(root: string): void;
}
const excluded =
  /(^|\/)(\.[^/]*|node_modules|vendor|dist|build|coverage|credentials?[^/]*|secrets?[^/]*|id_rsa[^/]*)(\/|$)|\.(pem|key|p12|pfx)$/i;
const supported =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|h|cpp|rb|ex|exs|proto|graphql|gql)$/i;
export function safeSnapshotPath(path: string): boolean {
  return (
    !!path &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !posix.isAbsolute(path) &&
    path.split("/").every((part) => part !== ".." && part !== ".") &&
    !excluded.test(path)
  );
}

const safeSnapshotRoot = (path: string) =>
  path === "." ||
  (!!path &&
    path.length <= 4096 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !posix.isAbsolute(path) &&
    !path
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          /^(\.env.*|\.pi|\.git|\.ssh|\.aws|credentials?.*|secrets?.*)$/i.test(part),
      ));

/** Only broker-returned source bytes enter this scratch graph. No project extension/config is loaded. */
export function createManagedFovea(
  scratch: string,
  opsEntry: string,
  call: BrokerCall,
  restore?: unknown,
  placement: { cwd: string; worktreeId?: string } = { cwd: "." },
) {
  let ops: GraphOps | undefined;
  const scopeKey = () => JSON.stringify([placement.cwd, placement.worktreeId ?? null]);
  const saved =
    restore && typeof restore === "object"
      ? (restore as { lastRoot?: unknown; observedRoots?: unknown; scope?: unknown })
      : {};
  const restored = saved.scope === scopeKey() ? saved : {};
  const bindings = new Set(
    Array.isArray(restored.observedRoots)
      ? restored.observedRoots
          .filter((root): root is string => typeof root === "string" && safeSnapshotRoot(root))
          .slice(0, 4)
      : [],
  );
  let lastRoot =
    typeof restored.lastRoot === "string" && bindings.has(restored.lastRoot)
      ? restored.lastRoot
      : ".";
  let chain = Promise.resolve();
  const roots = new Map<string, { local: string; hash: string; files: Set<string> }>();
  const loadOps = async () => (ops ??= (await import(pathToFileURL(opsEntry).href)) as GraphOps);
  const run = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: ExtensionContext,
  ) => {
    const root = typeof args.root === "string" ? args.root : lastRoot;
    if (!safeSnapshotRoot(root))
      throw new Error("Graph root must be an authorized computer-relative project path");
    const existing = roots.get(root);
    if (!bindings.has(root) && bindings.size >= 4) throw new Error("Graph root limit reached");
    const local =
      existing?.local ??
      join(
        scratch,
        createHash("sha256")
          .update(scopeKey() + root)
          .digest("hex"),
      );
    const queue = [""];
    const files = new Map<string, string>();
    let directories = 0;
    let bytes = 0;
    let omitted = 0;
    while (queue.length && directories < 64 && files.size < 256) {
      signal?.throwIfAborted();
      const directory = queue.shift()!;
      directories++;
      const listing = resultValue(
        await call("list_files", { path: posix.join(root, directory) }, signal, ctx),
      );
      if (!Array.isArray(listing.entries))
        throw new Error("Project graph unavailable: authorized listing has no entries");
      for (const raw of listing.entries.slice(0, 512)) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as Record<string, unknown>;
        // Derive a direct child name, never trust a returned absolute path or traversal.
        const returned = String(entry.path ?? entry.name ?? "");
        const prefix = posix.join(root, directory);
        const placedPrefix = posix.join(placement.cwd, prefix);
        const name = returned.startsWith(placedPrefix + "/")
          ? returned.slice(placedPrefix.length + 1)
          : returned.startsWith(prefix + "/")
            ? returned.slice(prefix.length + 1)
            : returned;
        if (name.includes("/") || !safeSnapshotPath(name)) {
          omitted++;
          continue;
        }
        const relative = directory ? `${directory}/${name}` : name;
        if (!safeSnapshotPath(relative)) {
          omitted++;
          continue;
        }
        if (entry.kind === "dir" || entry.type === "directory") {
          if (relative.split("/").length <= 8) queue.push(relative);
          else omitted++;
          continue;
        }
        if (
          (entry.kind !== "file" && entry.type !== "file") ||
          !supported.test(relative) ||
          files.size >= 256 ||
          bytes >= 2 * 1024 * 1024 ||
          (typeof entry.size === "number" && entry.size > 128 * 1024)
        ) {
          omitted++;
          continue;
        }
        const file = resultValue(
          await call("read_file", { path: posix.join(root, relative) }, signal, ctx),
        );
        if (
          typeof file.content !== "string" ||
          Buffer.byteLength(file.content) > 128 * 1024 ||
          bytes + Buffer.byteLength(file.content) > 2 * 1024 * 1024
        ) {
          omitted++;
          continue;
        }
        bytes += Buffer.byteLength(file.content);
        files.set(relative, file.content);
      }
      omitted += Math.max(0, listing.entries.length - 512);
    }
    if (!files.size)
      return textResult("Project graph unavailable: no authorized source files.", {
        root,
        available: false,
      });
    await mkdir(local, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256")
      .update(JSON.stringify([...files].sort()))
      .digest("hex");
    const graph = await loadOps();
    if (hash !== existing?.hash) {
      for (const path of existing?.files ?? []) if (!files.has(path)) await rm(join(local, path));
      for (const [path, content] of files) {
        await mkdir(join(local, posix.dirname(path)), { recursive: true, mode: 0o700 });
        await writeFile(join(local, path), content, { mode: 0o600 });
      }
      graph.evictState(local);
    }
    roots.set(root, { local, hash, files: new Set(files.keys()) });
    lastRoot = root;
    bindings.add(root);
    const budget =
      typeof args.maxTokens === "number" ? Math.min(2048, Math.max(128, args.maxTokens)) : 512;
    const result =
      name === "fovea_sketch"
        ? await graph.sketch(local, budget)
        : name === "fovea_focus"
          ? await graph.focus(local, String(args.query), budget)
          : name === "fovea_dwell"
            ? await graph.dwell(local, 2, budget)
            : await graph.impact(local, {
                files: Array.isArray(args.files) ? (args.files as string[]) : [...files.keys()],
                budget,
              });
    // Scratch spill paths are not computer paths and must never become read instructions.
    const text = result.text
      .replaceAll(local, root)
      .replace(/ — full list saved to [^\n]+/g, " — widen with fovea_dwell");
    return textResult(text, {
      root,
      observedRoots: [...bindings].sort(),
      available: true,
      files: files.size,
      bytes,
      omitted,
      truncated: queue.length > 0 || omitted > 0,
      generation: hash,
      mode: "augment",
    });
  };
  const tools: ToolDefinition[] = [
    "fovea_sketch",
    "fovea_focus",
    "fovea_dwell",
    "fovea_impact",
  ].map((name) => ({
    name,
    label: name,
    description:
      "Read-only Fovea graph of a bounded authorized computer snapshot. Paths are computer-relative; this augments, never replaces, source evidence.",
    parameters: Type.Object({
      root: Type.Optional(Type.String()),
      maxTokens: Type.Optional(Type.Number()),
      ...(name === "fovea_focus" ? { query: Type.String() } : {}),
      ...(name === "fovea_impact" ? { files: Type.Optional(Type.Array(Type.String())) } : {}),
    }),
    execute: async (_id, args, signal, _update, ctx) => {
      const pending = chain.then(() => run(name, args as Record<string, unknown>, signal, ctx));
      chain = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  }));
  return {
    tools,
    snapshot: () => ({ lastRoot, observedRoots: [...bindings], scope: scopeKey() }),
    async setPlacement(next: { cwd: string; worktreeId?: string }) {
      if (!safeSnapshotRoot(next.cwd)) throw new Error("Invalid authorized graph placement");
      await chain;
      if (JSON.stringify([next.cwd, next.worktreeId ?? null]) === scopeKey()) return;
      for (const root of roots.values()) ops?.evictState(root.local);
      await rm(scratch, { recursive: true, force: true });
      roots.clear();
      bindings.clear();
      lastRoot = ".";
      placement = { ...next };
    },
    dispose: async () => {
      await chain;
      for (const root of roots.values()) ops?.evictState(root.local);
    },
  };
}
