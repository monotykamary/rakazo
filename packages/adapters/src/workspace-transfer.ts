import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, AgentHomeStore, PortableFile } from "@rakazo/adapter-kit";
import { normalizeWorkspacePath } from "./computer-support.js";
import { shouldSkipPortableWorkspaceFile, writePortableFile } from "./computer-workspace.js";

export interface PortableFileManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
}

export interface PortableFileManifest {
  entries: PortableFileManifestEntry[];
}

/** Raised when a verified workspace copy cannot be produced or proven. */
export class WorkspaceTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTransferError";
  }
}

export function manifestEntry(file: PortableFile): PortableFileManifestEntry {
  return {
    path: file.path,
    bytes: file.content.byteLength,
    sha256: createHash("sha256").update(file.content).digest("hex"),
    executable: file.executable === true,
  };
}

export function buildPortableManifest(files: PortableFile[]): PortableFileManifest {
  return { entries: files.map(manifestEntry).sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * Compares two manifests read from durable homes. Any difference in paths,
 * sizes, hashes, or executable bits means the copy is not verified.
 */
export function verifyPortableManifest(
  actual: PortableFileManifest,
  expected: PortableFileManifest,
) {
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  if (
    actualByPath.size !== actual.entries.length ||
    expectedByPath.size !== expected.entries.length
  ) {
    throw new WorkspaceTransferError("Workspace manifest contains duplicate paths");
  }
  for (const [path, entry] of expectedByPath) {
    const found = actualByPath.get(path);
    if (!found) throw new WorkspaceTransferError(`Workspace copy is missing ${path}`);
    if (
      found.bytes !== entry.bytes ||
      found.sha256 !== entry.sha256 ||
      found.executable !== entry.executable
    ) {
      throw new WorkspaceTransferError(`Workspace copy does not match the source for ${path}`);
    }
  }
  const extra = actual.entries.find((entry) => !expectedByPath.has(entry.path));
  if (extra) throw new WorkspaceTransferError(`Workspace copy contains unexpected ${extra.path}`);
}

/**
 * Files eligible for a team bot's relocation: its own private area plus the
 * shared area, with original paths preserved. Other bots' private areas are
 * never copied, and a full team clone is intentionally not supported.
 */
export function teamBotAreaFilter(botId: string): (relative: string) => boolean {
  const own = `bots/${normalizeWorkspacePath(botId)}/`;
  return (relative) => relative.startsWith("shared/") || relative.startsWith(own);
}

export interface CopyAgentHomeDeps {
  home: AgentHomeStore;
  fromKey: string;
  toKey: string;
  context: AdapterContext;
  /** Optional path filter (relative, posix); unmatched files are not copied. */
  filter?: (relative: string) => boolean;
}

export interface CopyAgentHomeResult {
  revision: string;
  manifest: PortableFileManifest;
}

/**
 * Copies one home-store key to another through a safe staging directory and
 * verifies the committed copy by re-exporting it from the durable store (never
 * host or model-controlled paths). Transient browser state is excluded exactly
 * like a computer workspace export.
 */
export async function copyAgentHome(deps: CopyAgentHomeDeps): Promise<CopyAgentHomeResult> {
  const staging = await mkdtemp(path.join(tmpdir(), "rakazo-home-copy-"));
  try {
    const staged: PortableFileManifestEntry[] = [];
    for await (const file of deps.home.exportHome(deps.fromKey, deps.context)) {
      const relative = normalizeWorkspacePath(file.path);
      if (shouldSkipPortableWorkspaceFile(relative)) continue;
      if (deps.filter && !deps.filter(relative)) continue;
      await writePortableFile(staging, { ...file, path: relative });
      staged.push(manifestEntry({ ...file, path: relative }));
    }
    const revision = await deps.home.commit(deps.toKey, staging, deps.context);
    const verified: PortableFileManifestEntry[] = [];
    for await (const file of deps.home.exportHome(deps.toKey, deps.context)) {
      verified.push(manifestEntry(file));
    }
    const manifest = { entries: staged.sort((a, b) => a.path.localeCompare(b.path)) };
    verifyPortableManifest({ entries: verified }, manifest);
    return { revision, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
