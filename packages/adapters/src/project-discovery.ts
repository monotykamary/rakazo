import { posix } from "node:path";
import { teamBotWorkspaceDirectory } from "./computer-support.js";

/** Approved workspace roots a run may scan: its own area plus the shared Team area. Never a host path. */
export function approvedDiscoveryRoots(
  computerMode: "team" | "dedicated",
  botId: string,
): string[] {
  return computerMode === "team" ? [teamBotWorkspaceDirectory(botId), "shared"] : ["."];
}

export interface ProjectDiscoveryLimits {
  /** Directory depth searched below each approved root. */
  maxDepth: number;
  /** Repositories reported per scan before coverage is honestly marked truncated. */
  maxProjects: number;
  /** Filesystem entries consumed, including trees containing no repositories. */
  maxEntries?: number;
}

export const DEFAULT_PROJECT_DISCOVERY_LIMITS: Readonly<ProjectDiscoveryLimits> = Object.freeze({
  maxDepth: 4,
  maxProjects: 16,
  maxEntries: 4096,
});

export function discoveryRootsForDirectory(
  mode: "team" | "dedicated",
  botId: string,
  directory?: string,
): string[] {
  const roots = approvedDiscoveryRoots(mode, botId);
  if (directory === undefined) return roots;
  if (
    !directory ||
    directory.length > 4096 ||
    directory.startsWith("/") ||
    directory.includes("\\") ||
    [...directory].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    directory.split("/").includes("..")
  ) {
    throw new Error("Discovery directory must be a workspace-relative path");
  }
  const normalized = posix.normalize(directory).replace(/\/$/, "") || ".";
  if (
    mode === "team" &&
    !roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
  ) {
    throw new Error("Discovery directory is outside the bot and shared areas");
  }
  return [normalized];
}

const TRUNCATION_MARKER = "RAKAZO_PROJECT_DISCOVERY_TRUNCATED";

export interface DiscoveredProject {
  /** Workspace-relative canonical directory path; the only value used to bind work. */
  path: string;
  name: string;
  /** Credential-free remote identity, or null when absent or not safely representable. */
  remote: string | null;
  branch: string | null;
}

/**
 * Keeps only host and repository identity, dropping userinfo (usernames, tokens,
 * passwords) and anything that is not a network remote. Local file remotes never surface.
 */
export function sanitizeGitRemoteUrl(raw: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value || value.length > 512 || /\s/.test(value) || value.includes("\\")) return null;
  const urlMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/@]*@)?([^/]+)(\/.*)?$/.exec(value);
  if (urlMatch) {
    const [, scheme, , host, repoPath = "/"] = urlMatch;
    if (scheme !== "https" && scheme !== "http" && scheme !== "ssh" && scheme !== "git")
      return null;
    const cleanPath = repoPath.split(/[?#]/)[0] ?? "";
    if (cleanPath === "") return null;
    return scheme + "://" + host + cleanPath;
  }
  if (/:\/\//.test(value)) return null;
  const scpMatch = /^(?:[^@/]+@)?([^@:/\\]+):(.+)$/.exec(value);
  if (scpMatch) {
    const [, host, repoPath] = scpMatch;
    return host + ":" + repoPath;
  }
  return null;
}

/** Scheme-insensitive comparison form so https and scp remotes of one repo match. */
function gitRemoteIdentity(sanitized: string): string {
  return sanitized.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(":", "/");
}

export function discoveredProjectName(path: string): string {
  return path === "." ? "." : (path.split("/").at(-1) ?? path);
}

function normalizeProjectPath(raw: string): string | null {
  if (!raw || raw.length > 4096 || raw.includes("\0")) return null;
  const segments = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (segments.includes("..") || segments.some((segment) => segment.includes("\0"))) return null;
  return segments.length > 0 ? posix.join(...segments) : ".";
}

function sanitizeBranch(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 256 || /[\0\r\n]/.test(value)) return null;
  return value;
}

/**
 * Parses the bounded scan emitted by buildProjectDiscoveryCommand: tab-separated path,
 * remote, branch lines plus an explicit truncation marker, so limited coverage is
 * reported instead of silently guessed.
 */
export function parseProjectDiscoveryOutput(
  stdout: string,
  limits: ProjectDiscoveryLimits = DEFAULT_PROJECT_DISCOVERY_LIMITS,
): { projects: DiscoveredProject[]; truncated: boolean } {
  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith(TRUNCATION_MARKER)) {
      truncated = true;
      break;
    }
    const [rawPath = "", rawRemote = "", rawBranch = ""] = line.split("\t");
    const path = normalizeProjectPath(rawPath);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    projects.push({
      path,
      name: discoveredProjectName(path),
      remote: sanitizeGitRemoteUrl(rawRemote),
      branch: sanitizeBranch(rawBranch),
    });
    if (projects.length >= limits.maxProjects) {
      truncated = true;
      break;
    }
  }
  return { projects, truncated };
}

/**
 * Bounded, read-only scan of the caller authorized root. Never follows symlinks (a
 * symlinked .git is reported with null metadata), never descends into heavy build
 * directories or into a discovered repository, and never executes git inside a scanned
 * repository: origin and branch are read directly from HEAD and the config file inside
 * the scanned root, so config include directives, .git pointers to trees outside the
 * root, and repository hooks can never leak data across the boundary. Linked worktrees
 * surface as paths with null metadata because their gitdir lives outside the scanned
 * root. Emits one line per repository plus the truncation marker once the repository
 * or entry limit is reached. Depth-limited directories mark coverage partial; callers
 * can incrementally probe an authorized subdirectory instead of rescanning a whole tree.
 */
export function buildProjectDiscoveryCommand(limits: ProjectDiscoveryLimits): string {
  const bounded = (value: number, fallback: number, ceiling: number) =>
    Number.isFinite(value) ? Math.max(1, Math.min(ceiling, Math.floor(value))) : fallback;
  const maxDepth = bounded(limits.maxDepth, 4, 8);
  const maxProjects = bounded(limits.maxProjects, 16, 64);
  const maxEntries = bounded(limits.maxEntries ?? 4096, 4096, 16384);
  return [
    "set -o pipefail",
    "find . -maxdepth " +
      maxDepth +
      " \\( -name node_modules -o -name .venv -o -name venv -o -name dist \\) -prune -o \\( -name .git -prune -print0 \\) -o -print0 2>/dev/null | {",
    "n=0; entries=0; depth_limited=0",
    'while IFS= read -r -d "" gitdir; do',
    "  entries=$((entries + 1))",
    `  if [ "$entries" -gt ${maxEntries} ]; then`,
    "    printf '%s\\t\\t\\n' " + JSON.stringify(TRUNCATION_MARKER),
    "    break",
    "  fi",
    '  case "$gitdir" in',
    "    */.git) ;;",
    '    *) if [ ! -L "$gitdir" ] && [ -d "$gitdir" ] && [ "$gitdir" != . ]; then',
    "         rest=${gitdir#./}; depth=1",
    '         while [[ "$rest" == */* ]]; do rest=${rest#*/}; depth=$((depth + 1)); done',
    `         if [ "$depth" -ge ${maxDepth} ]; then depth_limited=1; fi`,
    "       fi",
    "       continue ;;",
    "  esac",
    "  n=$((n + 1))",
    '  if [ "$n" -gt ' + maxProjects + " ]; then",
    "    printf '%s\\t\\t\\n' " + JSON.stringify(TRUNCATION_MARKER),
    "    break",
    "  fi",
    '  p=$(dirname -- "$gitdir")',
    "  branch=",
    "  remote=",
    '  if [ ! -L "$gitdir" ] && [ -d "$gitdir" ] && [ -f "$gitdir/HEAD" ] && [ ! -L "$gitdir/HEAD" ]; then',
    '    headref=$(head -c 200 "$gitdir/HEAD" 2>/dev/null)',
    '    case "$headref" in',
    '      "ref: refs/heads/"*) branch=${headref#ref: refs/heads/} ;;',
    "    esac",
    "    branch=${branch%%[$'\\r\\n']*}",
    "  fi",
    '  if [ ! -L "$gitdir" ] && [ -d "$gitdir" ] && [ -f "$gitdir/config" ] && [ ! -L "$gitdir/config" ]; then',
    '    remote=$(head -c 65536 "$gitdir/config" 2>/dev/null | awk \'',
    '      /^\\[/ { origin = ($0 == "[remote \\"origin\\"]") ; next }',
    '      origin && $1 == "url" { sub(/^[^=]*=[ \\t]*/, ""); gsub(/^"|"$/, ""); sub(/\\r$/, ""); print; exit }',
    "    ')",
    "  fi",
    '  printf \'%s\\t%s\\t%s\\n\' "$p" "$remote" "$branch"',
    "done",
    'if [ "$depth_limited" -eq 1 ]; then',
    "  printf '%s\\t\\t\\n' " + JSON.stringify(TRUNCATION_MARKER),
    "fi",
    ":",
    "}",
    "status=$?",
    'if [ "$status" -eq 141 ]; then exit 0; fi',
    'exit "$status"',
  ].join("\n");
}

export type ProjectResolution =
  | { kind: "resolved"; project: DiscoveredProject }
  | { kind: "ambiguous"; candidates: DiscoveredProject[] }
  | { kind: "missing" };

/**
 * Deterministic resolution against a discovered set: exact path, then sanitized remote,
 * then unique name. Ambiguous matches are returned as candidates, never guessed.
 */
export function resolveProjectReference(
  projects: readonly DiscoveredProject[],
  reference: string,
): ProjectResolution {
  const ref = reference.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!ref) return { kind: "missing" };
  const byPath = projects.filter((p) => p.path === ref || (p.path === "." && ref === "."));
  if (byPath.length === 1) return { kind: "resolved", project: byPath[0]! };
  if (byPath.length > 1) return { kind: "ambiguous", candidates: byPath };
  const sanitizedRef = sanitizeGitRemoteUrl(ref);
  if (sanitizedRef) {
    const remoteIdentity = gitRemoteIdentity(sanitizedRef);
    const byRemote = projects.filter(
      (p) => p.remote !== null && gitRemoteIdentity(p.remote) === remoteIdentity,
    );
    if (byRemote.length === 1) return { kind: "resolved", project: byRemote[0]! };
    if (byRemote.length > 1) return { kind: "ambiguous", candidates: byRemote };
  }
  const lower = ref.toLowerCase();
  const byName = projects.filter((p) => p.name.toLowerCase() === lower);
  if (byName.length === 1) return { kind: "resolved", project: byName[0]! };
  if (byName.length > 1) return { kind: "ambiguous", candidates: byName };
  return { kind: "missing" };
}
