import { createHash } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import type {
  MemorySourceAction,
  MemorySourceCoverage,
  MemorySourceListPage,
  MemorySourceRecord,
  MemorySourceRequestContext,
  MemorySourceSessionDescriptor,
  MemorySourceSessionMetadata,
  MemorySourceSnapshot,
  PortableMemorySource,
} from "pi-fabric/memory";

/**
 * Host-authorized durable memory source for cross-conversation bot recall.
 *
 * Implements the pi-fabric `PortableMemorySource` contract (interface version
 * 1) over records Rakazo already retains: the bound current thread, the bot's
 * own DM thread, and same-owner non-archived group threads where the bot is
 * still a member. No second memory store and no parallel recall engine: the
 * Fabric memory engine performs recall/expand; this module only enumerates and
 * projects authorized durable content as safe plain visible text.
 *
 * The principal (spaceId, userId, botId, current thread/run, abort signal) is
 * bound by the host at factory time: scalar fields are copied and frozen so a
 * later mutation of the caller's object cannot redirect the source, while the
 * abort signal is preserved by reference. Authorization is rechecked against
 * the live database on every call — and again after every async session read —
 * so bot archive, group archive, membership revocation, run completion
 * cleanup, and message deletion take effect on the next list/recall/expand/
 * follow. A bound run row must still match the bound thread, and a bound
 * current thread that is deleted, foreign, another bot's DM, in an archived
 * group, or in a group whose ownership mismatches fails the WHOLE source
 * closed: nothing (including the bot's own DM) leaks into a revoked
 * destination. Every truncation cap is reported through Fabric
 * `coverage: { complete: false, reason }`, never as a silent bound.
 */

export const MEMORY_SOURCE_INTERFACE_VERSION = 1;

// Enumeration and projection bounds. Group enumeration probes one past the
// cap so a capped archive is reported incomplete instead of silently cut.
const SESSION_RECORDS_LIMIT = 400;
const SESSION_CHARS_LIMIT = 256_000;
const MESSAGE_CHARS_LIMIT = 8_000;
const GROUP_SESSIONS_LIMIT = 25;
const LIST_PAGE_LIMIT = GROUP_SESSIONS_LIMIT + 2;

/** Immutable-at-factory host-bound principal; the model never supplies one. */
export interface BotMemorySourcePrincipal {
  spaceId: string;
  userId: string;
  botId: string;
  threadId?: string;
  runId?: string;
  signal?: AbortSignal;
}

export interface BotMemorySourceOptions {
  prisma: PrismaClient;
  principal: BotMemorySourcePrincipal;
  /** Bound host runSecrets redaction, applied before ids and revisions derive. */
  redact?: (text: string) => string | Promise<string>;
}

interface BoundPrincipal extends Pick<BotMemorySourcePrincipal, "spaceId" | "userId" | "botId"> {
  readonly threadId?: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

interface SessionRef {
  sessionKey: string;
  threadId: string;
  role: "current" | "dm" | "group";
  title: string;
  updatedAtMs: number;
}

interface Enumeration {
  sessions: SessionRef[];
  /** False when group enumeration hit its cap and more groups may exist. */
  complete: boolean;
}

interface MessageRow {
  seq: number;
  role: string;
  blocks: unknown;
  createdAt: Date;
}

interface RenderFlags {
  clipped: boolean;
  unrendered: boolean;
}

const EMPTY_ENUMERATION: Enumeration = { sessions: [], complete: true };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (value: string, length: number) => sha256(value).slice(0, length);
/** Opaque, stable, path-free session key; recomputed to resolve, never parsed. */
export const botMemorySessionKey = (principal: BotMemorySourcePrincipal, threadId: string) =>
  `bms1-${token(`${principal.spaceId}|${principal.userId}|${principal.botId}|${threadId}`, 24)}`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asText = (value: unknown, max: number, flags?: RenderFlags): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) {
    if (flags) flags.clipped = true;
    return `${text.slice(0, max)}…`;
  }
  return text;
};

const blockKind = (block: unknown) => asRecord(block)?.kind ?? "unknown";

/**
 * Product-visible plain text only. Raw block objects are never copied: cards
 * can carry secret arguments, tool payloads, or private host state. Secret ask
 * answers are withheld; unrendered block kinds say so instead of guessing, and
 * set the coverage flags so a partially projected session is never presented
 * as complete.
 */
function renderBlock(block: unknown, max: number, flags: RenderFlags): string | undefined {
  const b = asRecord(block);
  if (!b) return undefined;
  const text = asText(b.text, max, flags);
  const name = asText(b.name, 120);
  const status = asText(b.status, 20);
  switch (b.kind) {
    case "text":
      return text;
    case "meta":
      return text && `note: ${text}`;
    case "progress":
      return text && `progress: ${text}`;
    case "computer":
      return text && `${text} (${asText(b.state, 40) ?? "unknown"})`;
    case "routine_change":
      return `routine ${name ?? "unknown"} ${asText(b.action, 20) ?? "changed"}`;
    case "card": {
      const lines = Array.isArray(b.lines) ? b.lines : [];
      const parts = lines
        .map((line) => asRecord(line))
        .map((line) => (line ? [asText(line.k, 60), asText(line.v, 200, flags)] : []))
        .map(([k, v]) => (k && v ? `${k}: ${v}` : undefined))
        .filter((part): part is string => Boolean(part));
      return parts.length ? `card: ${parts.join("; ")}` : undefined;
    }
    case "ask": {
      if (!text) return undefined;
      // A secret ask's answer never leaves the store even though the block is
      // visible in the product UI.
      if (b.input === "secret") return `${text} (answer withheld)`;
      const answer = asText(b.answer, max, flags);
      return answer ? `${text} — answer: ${answer}` : text;
    }
    case "choice": {
      if (!text) return undefined;
      const options = (Array.isArray(b.options) ? b.options : [])
        .map((option) => asRecord(option))
        .map((option) => (option ? asText(option.label, 80) : undefined))
        .filter((label): label is string => Boolean(label));
      const answered = b.answerId === undefined ? "" : " (answered)";
      return `question: ${text} (options: ${options.join(", ")})${answered}`;
    }
    case "steps": {
      const parts = (Array.isArray(b.steps) ? b.steps : [])
        .map((step) => asRecord(step))
        .map((step) => {
          if (!step) return undefined;
          const label = asText(step.label, 80);
          if (!label) return undefined;
          return typeof step.count === "number" ? `${label}×${step.count}` : label;
        })
        .filter((part): part is string => Boolean(part));
      return parts.length ? `steps: ${parts.join(", ")}` : undefined;
    }
    case "subagent": {
      // Product-visible subagent evidence: the sanctioned checkpoint-derived
      // coverage. Raw participant checkpoints are never exposed instead.
      const agentId = asText(b.agentId, 40);
      if (!name && !agentId) return undefined;
      const parts = [`subagent ${name ?? "unnamed"}${agentId ? ` (${agentId})` : ""}`];
      for (const part of [asText(b.task, 400, flags), status, asText(b.progress, 400, flags)])
        if (part) parts.push(part);
      const result = asText(b.result, max, flags);
      if (result) parts.push(`result: ${result}`);
      return parts.join(": ");
    }
    case "child_bot":
      return name ? `bot ${name} ${status ?? "updated"}` : undefined;
    case "cloud_agent": {
      if (!name) return undefined;
      const branch = asText(b.branch, 120);
      const prUrl = asText(b.prUrl, 200);
      return `cloud agent ${name}: ${status ?? "unknown"}${branch ? ` (${branch}${prUrl ? `, ${prUrl}` : ""})` : ""}`;
    }
    case "skill_draft": {
      const goal = asText(b.goal, 200, flags);
      return name ? `skill draft ${name}${goal ? `: ${goal}` : ""}` : undefined;
    }
    case "image":
      return name ? `attached image ${name}` : "attached image";
    case "file": {
      const mimeType = asText(b.mimeType, 60);
      return name ? `attached file ${name}${mimeType ? ` (${mimeType})` : ""}` : "attached file";
    }
    case "chart":
      return name ? `chart ${name}` : "chart";
    case "connect":
    case "app_connect":
    case "mcp_approval":
      return name ? (status ? `${name}: ${status}` : name) : undefined;
    case "handoff": {
      const toBotId = asText(b.toBotId, 40);
      return text ? `handed off${toBotId ? ` to bot ${toBotId}` : ""}: ${text}` : undefined;
    }
    case "channel_message": {
      const from = asText(b.fromLabel, 120);
      return text ? `message from ${from ?? "unknown"}: ${text}` : undefined;
    }
    case "bot_message_sent": {
      const to = asText(b.toBotName, 120);
      return text ? `sent to bot ${to ?? "unknown"}: ${text}` : undefined;
    }
    case "bot_message_received": {
      const from = asText(b.fromBotName, 120);
      return text ? `message from bot ${from ?? "unknown"}: ${text}` : undefined;
    }
    default:
      return undefined;
  }
}

function renderMessageText(row: MessageRow, max: number): { text: string; flags: RenderFlags } {
  const flags: RenderFlags = { clipped: false, unrendered: false };
  const blocks = Array.isArray(row.blocks) ? row.blocks : [];
  const rendered: string[] = [];
  for (const block of blocks) {
    const line = renderBlock(block, max, flags);
    if (line === undefined) {
      flags.unrendered = true;
      rendered.push(`[unrendered ${String(blockKind(block))} block]`);
    } else {
      rendered.push(line);
    }
  }
  return { text: rendered.length ? rendered.join("\n") : "[empty message]", flags };
}

async function checkAborts(bound: BoundPrincipal, signal: AbortSignal | undefined) {
  bound.signal?.throwIfAborted();
  signal?.throwIfAborted();
}

const sameOwnerGroup = (bound: BoundPrincipal) => ({
  spaceId: bound.spaceId,
  userId: bound.userId,
  archivedAt: null,
});

/**
 * Re-resolves authority from the live database: the bot row (not archived,
 * same space and owner), the bound run row when bound (it must still match
 * the bound thread), and every candidate thread's current authorization.
 * Deleted, archived, or revoked entries disappear. If the bound current
 * thread itself is not authorized — deleted, foreign, another bot's DM, group
 * archived, group ownership mismatched, or membership revoked — the whole
 * source fails closed so nothing (including the bot's own DM) leaks into a
 * destination that lost access.
 */
async function authorizedSessions(
  prisma: PrismaClient,
  bound: BoundPrincipal,
  signal: AbortSignal | undefined,
): Promise<Enumeration> {
  await checkAborts(bound, signal);
  const { spaceId, userId, botId } = bound;
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId, userId, archivedAt: null },
    select: { id: true },
  });
  if (!bot) return EMPTY_ENUMERATION;
  if (bound.runId) {
    const run = await prisma.run.findFirst({
      where: { id: bound.runId, spaceId, botId, userId, threadId: bound.threadId },
      select: { id: true },
    });
    if (!run) return EMPTY_ENUMERATION;
  }
  const sessions = new Map<string, SessionRef>();
  // Threads have no updatedAt; order by the latest retained message instead.
  type ThreadRow = {
    id: string;
    createdAt: Date;
    messages?: Array<{ createdAt: Date }>;
  };
  const addThread = (row: ThreadRow | null, role: SessionRef["role"], title: string) => {
    if (!row || sessions.has(row.id)) return undefined;
    const session: SessionRef = {
      sessionKey: botMemorySessionKey(bound, row.id),
      threadId: row.id,
      role,
      title,
      updatedAtMs: (row.messages?.[0]?.createdAt ?? row.createdAt).getTime(),
    };
    sessions.set(row.id, session);
    return session;
  };
  if (bound.threadId) {
    const thread = await prisma.thread.findFirst({
      where: { id: bound.threadId, spaceId, userId },
      select: {
        id: true,
        botId: true,
        groupId: true,
        createdAt: true,
        group: { select: { name: true } },
        messages: {
          orderBy: { seq: "desc" },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    let current: SessionRef | undefined;
    if (thread && thread.botId === botId) {
      current = addThread(thread, "current", "Direct chat");
    } else if (thread?.groupId) {
      // Another bot's DM thread is never authorized; group threads only while
      // this bot is still a member of the same-owner, non-archived group.
      const member = await prisma.chatGroupMember.findFirst({
        where: { groupId: thread.groupId, botId, group: sameOwnerGroup(bound) },
        select: { id: true },
      });
      if (member) current = addThread(thread, "current", thread.group?.name || "Group chat");
    }
    if (!current) return EMPTY_ENUMERATION;
  }
  const dm = await prisma.thread.findFirst({
    where: { botId, spaceId, userId },
    select: {
      id: true,
      createdAt: true,
      messages: { orderBy: { seq: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
  if (dm) addThread(dm, "dm", "Direct chat");
  const memberships = await prisma.chatGroupMember.findMany({
    where: { botId, group: sameOwnerGroup(bound) },
    select: {
      group: {
        select: {
          id: true,
          name: true,
          thread: {
            select: {
              id: true,
              createdAt: true,
              messages: {
                orderBy: { seq: "desc" },
                take: 1,
                select: { createdAt: true },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    // Probe one past the cap so a capped archive reports incomplete coverage.
    take: GROUP_SESSIONS_LIMIT + 1,
  });
  const complete = memberships.length <= GROUP_SESSIONS_LIMIT;
  for (const membership of memberships.slice(0, GROUP_SESSIONS_LIMIT)) {
    const group = membership.group;
    if (group?.thread) addThread(group.thread, "group", group.name || "Group chat");
  }
  return { sessions: [...sessions.values()], complete };
}

/** Cheap deterministic revision from durable message state (max seq + count). */
async function threadRevision(prisma: PrismaClient, threadId: string) {
  const stats = await prisma.message.aggregate({
    where: { threadId },
    _max: { seq: true },
    _count: true,
  });
  const base = `${threadId}|${stats._max.seq ?? -1}|${stats._count}`;
  return `rakazo-v1-${token(base, 16)}`;
}

function originRecord(role: SessionRef["role"], title: string): MemorySourceRecord {
  return {
    type: "custom_message",
    id: "rakazo-origin",
    customType: "rakazo.memory.origin",
    data: { role, title },
  };
}

function messageRecord(row: MessageRow, parentId: string, text: string): MemorySourceRecord {
  return {
    type: "message",
    id: `rakazo-m${row.seq}`,
    parentId,
    timestamp: row.createdAt.getTime(),
    message: {
      role: row.role === "user" ? "user" : "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function truncationRecord(parentId: string, reason: string): MemorySourceRecord {
  return {
    type: "custom_message",
    id: "rakazo-truncated",
    parentId,
    customType: "rakazo.memory.truncated",
    data: { reason },
  };
}

async function loadSessionSnapshot(
  prisma: PrismaClient,
  bound: BoundPrincipal,
  redact: (text: string) => string | Promise<string>,
  session: SessionRef,
  signal: AbortSignal | undefined,
): Promise<MemorySourceSnapshot> {
  await checkAborts(bound, signal);
  const thread = await prisma.thread.findUnique({
    where: { id: session.threadId },
    select: { sessionStartedAfterSeq: true },
  });
  const rows = await prisma.message.findMany({
    where: {
      threadId: session.threadId,
      ...(thread?.sessionStartedAfterSeq == null
        ? {}
        : { seq: { gt: thread.sessionStartedAfterSeq } }),
    },
    orderBy: { seq: "desc" },
    take: SESSION_RECORDS_LIMIT + 1,
    select: { seq: true, role: true, blocks: true, createdAt: true },
  });
  const overRecords = rows.length > SESSION_RECORDS_LIMIT;
  // Prefer recent work in long conversations; retain chronological parent links.
  const visible = rows.slice(0, SESSION_RECORDS_LIMIT);
  const selected: Array<{ row: MessageRow; text: string }> = [];
  // Titles are host redacted before they enter metadata or origin records;
  // revisions hash only post-redaction content.
  const title = await redact(session.title);
  const records: MemorySourceRecord[] = [originRecord(session.role, title)];
  let parentId = "rakazo-origin";
  let remaining = SESSION_CHARS_LIMIT;
  let overChars = false;
  let clippedMessages = false;
  let unrendered = false;
  for (const row of visible) {
    await checkAborts(bound, signal);
    const rendered = renderMessageText(row, MESSAGE_CHARS_LIMIT);
    unrendered ||= rendered.flags.unrendered;
    clippedMessages ||= rendered.flags.clipped;
    let text = await redact(rendered.text);
    if (text.length > MESSAGE_CHARS_LIMIT) {
      text = text.slice(0, MESSAGE_CHARS_LIMIT);
      clippedMessages = true;
    }
    if (text.length > remaining) {
      overChars = true;
      break;
    }
    remaining -= text.length;
    selected.push({ row, text });
  }
  for (const { row, text } of selected.reverse()) {
    records.push(messageRecord(row, parentId, text));
    parentId = `rakazo-m${row.seq}`;
  }
  if (overRecords || overChars)
    records.push(
      truncationRecord(parentId, overChars ? "session_chars_limit" : "session_records_limit"),
    );
  const reason = overChars
    ? "session_chars"
    : overRecords
      ? "max_records"
      : clippedMessages
        ? "message_chars"
        : unrendered
          ? "unrendered_blocks"
          : undefined;
  // Revision binds to the rows actually read (max seq + row count + record
  // hash), so a concurrent deletion can never bind stale rows to a revision
  // of state the snapshot does not contain.
  const lastRow = visible[0];
  const lastSeq = lastRow ? lastRow.seq : -1;
  const revision = `rakazo-v1-${token(
    `${session.threadId}|${lastSeq}|${visible.length}|${sha256(JSON.stringify(records))}`,
    16,
  )}`;
  const snapshot: MemorySourceSnapshot = {
    sessionKey: session.sessionKey,
    sessionId: session.sessionKey,
    revision,
    metadata: { title, updatedAt: session.updatedAtMs },
    records,
  };
  if (reason) {
    const coverage: MemorySourceCoverage = { complete: false, reason };
    snapshot.coverage = coverage;
  }
  return snapshot;
}

/**
 * Factory the executor calls once per run: one authorized archive bound to the
 * run's principal, registered into a single-source registry and served through
 * the bounded Fabric memory engine (see bot-memory-client.ts).
 */
export function createBotMemorySource(options: BotMemorySourceOptions): PortableMemorySource {
  // Scalar principal fields are copied and frozen at factory time; the abort
  // signal is preserved by reference. Later mutation of the caller's object
  // cannot redirect the source to another space, bot, thread, or run.
  const bound: BoundPrincipal = Object.freeze({
    spaceId: options.principal.spaceId,
    userId: options.principal.userId,
    botId: options.principal.botId,
    threadId: options.principal.threadId,
    runId: options.principal.runId,
    signal: options.principal.signal,
  });
  const redact = options.redact ?? ((text: string) => text);
  const enumerate = (signal: AbortSignal | undefined) =>
    authorizedSessions(options.prisma, bound, signal);
  const metadata = async (session: SessionRef): Promise<MemorySourceSessionMetadata> => ({
    title: await redact(session.title),
    updatedAt: session.updatedAtMs,
  });
  return {
    interfaceVersion: MEMORY_SOURCE_INTERFACE_VERSION,
    id: `rakazo-bot-memory-${token(`${bound.spaceId}|${bound.userId}|${bound.botId}`, 12)}`,
    async listSessions({ limit, signal }: { limit: number } & MemorySourceRequestContext) {
      const found = await enumerate(signal);
      const clamped = Math.max(0, Math.min(limit, LIST_PAGE_LIMIT));
      const descriptors: MemorySourceSessionDescriptor[] = [];
      for (const session of found.sessions.slice(0, clamped)) {
        await checkAborts(bound, signal);
        descriptors.push({
          sessionKey: session.sessionKey,
          sessionId: session.sessionKey,
          revision: await threadRevision(options.prisma, session.threadId),
          metadata: await metadata(session),
        });
      }
      const reason = !found.complete
        ? "max_group_sessions"
        : found.sessions.length > clamped
          ? "list_limit"
          : undefined;
      if (reason === undefined) return descriptors;
      const page: MemorySourceListPage = {
        sessions: descriptors,
        coverage: { complete: false, reason },
      };
      return page;
    },
    async loadSession(sessionKey: string, { signal }: MemorySourceRequestContext) {
      const found = await enumerate(signal);
      const session = found.sessions.find((entry) => entry.sessionKey === sessionKey);
      if (!session) return null;
      const snapshot = await loadSessionSnapshot(options.prisma, bound, redact, session, signal);
      // Revalidate the destination after the async read: a membership,
      // archive, or run revocation mid-read fails the whole load closed.
      const recheck = await enumerate(signal);
      if (!recheck.sessions.some((entry) => entry.sessionKey === sessionKey)) return null;
      return snapshot;
    },
    async authorize(action: MemorySourceAction, sessionKey: string | null) {
      // Rechecked by the client after every recall/expand/sessions call.
      void action;
      const found = await enumerate(undefined);
      if (sessionKey) return found.sessions.some((entry) => entry.sessionKey === sessionKey);
      // A fully revoked principal authorizes nothing, not even bare listing.
      return found.sessions.length > 0;
    },
  };
}
