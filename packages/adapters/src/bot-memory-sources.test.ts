import type { PrismaClient } from "@rakazo/db";
import type {
  MemorySourceListPage,
  MemorySourceRecord,
  MemorySourceSessionDescriptor,
} from "pi-fabric/memory";
import { describe, expect, it } from "vitest";
import {
  botMemorySessionKey,
  createBotMemorySource,
  MEMORY_SOURCE_INTERFACE_VERSION,
} from "./bot-memory-sources.js";

type Row = Record<string, unknown>;
const sessionRows = (page: MemorySourceListPage | readonly MemorySourceSessionDescriptor[]) =>
  "sessions" in page ? page.sessions : page;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    const current = row[key];
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      if (current !== null && typeof current === "object" && !Array.isArray(current))
        return matches(current as Row, value as Row);
      return false;
    }
    return current === value;
  });
}

type Query = { where?: Row; take?: number; orderBy?: { seq?: "asc" | "desc" } };

type FakeOptions = {
  afterMessageRead?: () => void;
  failAggregate?: boolean;
};

function fakePrisma(
  data: {
    bots?: Row[];
    runs?: Row[];
    threads?: Row[];
    memberships?: Row[];
    messages?: Row[];
  },
  options: FakeOptions = {},
): PrismaClient {
  const first = (rows: Row[], where: Row | undefined) =>
    rows.find((row) => matches(row, where)) ?? null;
  return {
    bot: { findFirst: async (args: Query) => first(data.bots ?? [], args?.where) },
    run: { findFirst: async (args: Query) => first(data.runs ?? [], args?.where) },
    thread: { findFirst: async (args: Query) => first(data.threads ?? [], args?.where) },
    chatGroupMember: {
      findFirst: async (args: Query) => first(data.memberships ?? [], args?.where),
      findMany: async (args: Query) => {
        const rows = (data.memberships ?? []).filter((row) => matches(row, args?.where));
        const sorted = [...rows].sort((a, b) =>
          String(a.createdAt).localeCompare(String(b.createdAt)),
        );
        return typeof args?.take === "number" ? sorted.slice(0, args.take) : sorted;
      },
    },
    message: {
      aggregate: async (args: Query) => {
        if (options.failAggregate) throw new Error("aggregate must not run on the load path");
        const rows = (data.messages ?? []).filter((row) => matches(row, args?.where));
        const maxSeq = rows.reduce((max, row) => Math.max(max, row.seq as number), -1);
        return { _max: { seq: rows.length ? maxSeq : null }, _count: rows.length };
      },
      findMany: async (args: Query) => {
        const rows = (data.messages ?? []).filter((row) => matches(row, args?.where));
        options.afterMessageRead?.();
        const direction = args.orderBy?.seq === "desc" ? -1 : 1;
        const sorted = [...rows].sort(
          (a, b) => direction * ((a.seq as number) - (b.seq as number)),
        );
        return typeof args?.take === "number" ? sorted.slice(0, args.take) : sorted;
      },
    },
  } as unknown as PrismaClient;
}

const T0 = new Date("2026-01-01T00:00:00.000Z");
const message = (threadId: string, seq: number, blocks: Row[], role = "bot") => ({
  id: `m-${threadId}-${seq}`,
  threadId,
  seq,
  role,
  blocks,
  createdAt: T0,
});

const controller = () => new AbortController();
const principal = () => ({
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-a",
  threadId: "thread-group-current",
  runId: "run-1",
  signal: controller().signal,
});

const revokeBoundMembership = (data: ReturnType<typeof fixtures>) => {
  data.memberships = data.memberships.filter(
    (row) => !(row.botId === "bot-a" && row.groupId === "group-1"),
  );
};

function fixtures() {
  const groupThread = (id: string, groupId: string, userId = "user-1", group?: Row) =>
    ({
      id,
      spaceId: "space-1",
      userId,
      botId: null,
      groupId,
      createdAt: T0,
      group,
      messages: [{ createdAt: T0 }],
    }) as Row;
  const group = (
    id: string,
    threadId: string,
    options: { archived?: boolean; userId?: string } = {},
  ) => ({
    id,
    spaceId: "space-1",
    userId: options.userId ?? "user-1",
    archivedAt: options.archived ? T0 : null,
    name: id,
    thread: groupThread(threadId, id, options.userId),
  });
  return {
    bots: [
      { id: "bot-a", spaceId: "space-1", userId: "user-1", archivedAt: null },
      { id: "bot-b", spaceId: "space-1", userId: "user-1", archivedAt: null },
      { id: "bot-c", spaceId: "space-1", userId: "user-1", archivedAt: T0 },
    ],
    runs: [
      {
        id: "run-1",
        spaceId: "space-1",
        botId: "bot-a",
        userId: "user-1",
        threadId: "thread-group-current",
      },
    ],
    threads: [
      groupThread("thread-group-current", "group-1", "user-1", { name: "Incident sk-live-alpha" }),
      {
        id: "thread-dm",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-a",
        groupId: null,
        createdAt: T0,
        messages: [{ createdAt: T0 }],
      },
      groupThread("thread-group-other", "group-2"),
      groupThread("thread-group-archived", "group-3"),
      groupThread("thread-group-foreign", "group-4", "user-2"),
      // Same-owner thread whose group is owned by someone else.
      groupThread("thread-group-foreign-owner", "group-6", "user-1"),
      {
        id: "thread-dm-bot-b",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-b",
        groupId: null,
        createdAt: T0,
        messages: [{ createdAt: T0 }],
      },
    ],
    memberships: [
      {
        botId: "bot-a",
        groupId: "group-1",
        createdAt: T0,
        group: group("group-1", "thread-group-current"),
      },
      {
        botId: "bot-a",
        groupId: "group-2",
        createdAt: T0,
        group: group("group-2", "thread-group-other"),
      },
      {
        botId: "bot-a",
        groupId: "group-3",
        createdAt: T0,
        group: group("group-3", "thread-group-archived", { archived: true }),
      },
      {
        botId: "bot-a",
        groupId: "group-4",
        createdAt: T0,
        group: group("group-4", "thread-group-foreign", { userId: "user-2" }),
      },
      {
        botId: "bot-a",
        groupId: "group-6",
        createdAt: T0,
        group: group("group-6", "thread-group-foreign-owner", { userId: "user-2" }),
      },
      {
        botId: "bot-b",
        groupId: "group-5",
        createdAt: T0,
        group: group("group-5", "thread-group-nonmember"),
      },
    ],
    messages: [
      message(
        "thread-group-current",
        0,
        [{ kind: "text", text: "check the deploy status" }],
        "user",
      ),
      message("thread-group-current", 1, [
        {
          kind: "subagent",
          agentId: "agent-9",
          name: "Scout",
          task: "scan logs",
          status: "completed",
          result: "all clear",
        },
      ]),
      message(
        "thread-group-current",
        2,
        [{ kind: "ask", text: "api token?", input: "secret", answer: "sk-live-secret" }],
        "user",
      ),
      message("thread-dm", 0, [{ kind: "text", text: "prior DM output Q-7 results" }]),
      message("thread-group-other", 0, [
        { kind: "card", lines: [{ k: "path", v: "/home/rakazo/private" }] },
      ]),
    ],
  };
}

describe("bot memory source", () => {
  it("declares the pi-fabric interface version and an opaque stable source id", () => {
    const source = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: principal(),
    });
    expect(source.interfaceVersion).toBe(MEMORY_SOURCE_INTERFACE_VERSION);
    expect(source.id.startsWith("rakazo-bot-memory-")).toBe(true);
  });

  it("enumerates only the bound current, own DM, and same-owner member groups", async () => {
    const source = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: principal(),
    });
    const sessions = await source.listSessions({ limit: 32 });
    const keys = sessionRows(sessions).map((session) => session.sessionKey);
    expect(keys).toContain(botMemorySessionKey(principal(), "thread-group-current"));
    expect(keys).toContain(botMemorySessionKey(principal(), "thread-dm"));
    expect(keys).toContain(botMemorySessionKey(principal(), "thread-group-other"));
    // Archived group, foreign-owner group, non-member group, and another bot's
    // DM thread never appear, and keys never carry raw thread ids.
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(/^bms1-[0-9a-f]{24}$/);
      expect(key).not.toContain("thread-");
    }
  });

  it("projects safe plain visible text with subagent provenance and no raw blocks", async () => {
    const source = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: principal(),
    });
    const snapshot = await source.loadSession(
      botMemorySessionKey(principal(), "thread-group-current"),
      {},
    );
    expect(snapshot).not.toBeNull();
    const text = JSON.stringify(snapshot?.records);
    expect(text).toContain("check the deploy status");
    expect(text).toContain("subagent Scout (agent-9): scan logs: completed: result: all clear");
    expect(text).not.toContain("sk-live-secret");
    expect(text).toContain("answer withheld");
    expect(text).not.toContain('"kind"');
    expect(text).not.toContain("/home/rakazo");
    const roles = (snapshot?.records ?? []).map((record) => (record as Row).type);
    expect(roles[0]).toBe("custom_message");
    expect(roles).toContain("message");
    expect(snapshot?.coverage).toBeUndefined();
  });

  it("recalls prior DM output from a group turn without any remember call", async () => {
    const source = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: principal(),
    });
    const snapshot = await source.loadSession(botMemorySessionKey(principal(), "thread-dm"), {});
    const text = JSON.stringify(snapshot?.records);
    expect(text).toContain("prior DM output Q-7 results");
    expect(await source.authorize!("recall", botMemorySessionKey(principal(), "thread-dm"))).toBe(
      true,
    );
  });

  it("applies host runSecret redaction before deriving stable ids and revisions", async () => {
    const data = fixtures();
    data.messages.push(message("thread-dm", 1, [{ kind: "text", text: "token sk-live-123 ok" }]));
    const bare = createBotMemorySource({ prisma: fakePrisma(data), principal: principal() });
    const redacted = createBotMemorySource({
      prisma: fakePrisma(data),
      principal: principal(),
      redact: (text) => text.replaceAll("sk-live-123", "[redacted]"),
    });
    const key = botMemorySessionKey(principal(), "thread-dm");
    const bareSnapshot = (await bare.loadSession(key, {}))!;
    const redactedSnapshot = (await redacted.loadSession(key, {}))!;
    expect(JSON.stringify(bareSnapshot.records)).toContain("sk-live-123");
    expect(JSON.stringify(redactedSnapshot.records)).not.toContain("sk-live-123");
    expect(redactedSnapshot.revision).not.toBe(bareSnapshot.revision);
    const repeat = (await redacted.loadSession(key, {}))!;
    expect(repeat.revision).toBe(redactedSnapshot.revision);
  });

  it("rechecks authority on every call so revocation, archive, and deletion fail closed", async () => {
    const data = fixtures();
    const prisma = fakePrisma(data);
    const source = createBotMemorySource({ prisma, principal: principal() });
    const groupKey = botMemorySessionKey(principal(), "thread-group-other");
    expect(
      sessionRows(await source.listSessions({ limit: 32 })).map((s) => s.sessionKey),
    ).toContain(groupKey);
    // Membership revocation takes effect on the next call.
    data.memberships = data.memberships.filter((row) => row.groupId !== "group-2");
    expect(await source.loadSession(groupKey, {})).toBeNull();
    expect(
      sessionRows(await source.listSessions({ limit: 32 })).map((s) => s.sessionKey),
    ).not.toContain(groupKey);
    // Bot archive or bound-run deletion revokes the whole source.
    data.bots = data.bots.map((row) => (row.id === "bot-a" ? { ...row, archivedAt: T0 } : row));
    expect(await source.authorize!("list", null)).toBe(false);
    expect(await source.loadSession(botMemorySessionKey(principal(), "thread-dm"), {})).toBeNull();
    data.bots = data.bots.map((row) => (row.id === "bot-a" ? { ...row, archivedAt: null } : row));
    data.runs = [];
    expect(await source.listSessions({ limit: 32 })).toEqual([]);
  });

  it("rejects forged, foreign-principal, and unknown session keys", async () => {
    const source = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: principal(),
    });
    expect(await source.loadSession("bms1-" + "f".repeat(24), {})).toBeNull();
    const otherBot = { ...principal(), botId: "bot-b" };
    expect(
      await source.loadSession(botMemorySessionKey(otherBot, "thread-dm-bot-b"), {}),
    ).toBeNull();
    expect(
      await source.authorize!("expand", botMemorySessionKey(otherBot, "thread-dm-bot-b")),
    ).toBe(false);
  });

  it("honors the bound abort signal and per-call signals between loads", async () => {
    const signal = controller();
    const source = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: { ...principal(), signal: signal.signal },
    });
    signal.abort();
    await expect(source.listSessions({ limit: 32 })).rejects.toMatchObject({
      name: "AbortError",
    });
    const late = controller();
    const active = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: principal(),
    });
    late.abort();
    await expect(
      active.loadSession(botMemorySessionKey(principal(), "thread-dm"), {
        signal: late.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds session loads with an explicit truncation marker and incomplete coverage", async () => {
    const data = fixtures();
    for (let seq = 1; seq <= 402; seq += 1)
      data.messages.push(message("thread-dm", seq, [{ kind: "text", text: `row ${seq}` }]));
    const source = createBotMemorySource({ prisma: fakePrisma(data), principal: principal() });
    const snapshot = (await source.loadSession(botMemorySessionKey(principal(), "thread-dm"), {}))!;
    const messageRecords = snapshot.records.filter((record) => record.type === "message");
    expect(messageRecords).toHaveLength(400);
    expect(messageRecords[0]?.id).toBe("rakazo-m3");
    expect(messageRecords.at(-1)?.id).toBe("rakazo-m402");
    const last = snapshot.records.at(-1) as MemorySourceRecord;
    expect(last.customType).toBe("rakazo.memory.truncated");
    expect((last.data as Row).reason).toBe("session_records_limit");
    expect(snapshot.coverage).toEqual({ complete: false, reason: "max_records" });
    // Lineage stays one parent-linked chain across every record.
    let parentId = "rakazo-origin";
    for (const record of snapshot.records.slice(1)) {
      expect(record.parentId).toBe(parentId);
      parentId = record.id as string;
    }
  });

  it("fails the whole source closed when the bound group destination loses membership while the DM persists", async () => {
    const data = fixtures();
    const prisma = fakePrisma(data);
    const source = createBotMemorySource({ prisma, principal: principal() });
    const dmKey = botMemorySessionKey(principal(), "thread-dm");
    expect(await source.authorize!("recall", dmKey)).toBe(true);
    revokeBoundMembership(data);
    // The DM itself is untouched, but the revoked destination sees nothing.
    expect(await source.listSessions({ limit: 32 })).toEqual([]);
    expect(await source.loadSession(dmKey, {})).toBeNull();
    expect(
      await source.loadSession(botMemorySessionKey(principal(), "thread-group-current"), {}),
    ).toBeNull();
    expect(await source.authorize!("recall", dmKey)).toBe(false);
    expect(await source.authorize!("list", null)).toBe(false);
  });

  it("fails closed for a deleted, archived-group, foreign-owner, or rebound bound thread", async () => {
    const cases: Array<(data: ReturnType<typeof fixtures>) => void> = [
      // Deleted bound thread.
      (data) => {
        data.threads = data.threads!.filter((row) => row.id !== "thread-group-current");
      },
      // Archived bound group.
      (data) => {
        const membership = data.memberships!.find((row) => row.groupId === "group-1");
        (membership!.group as Row).archivedAt = T0;
      },
      // Bound thread whose group is owned by another user.
      (data) => {
        data.threads = data.threads!.map((row) =>
          row.id === "thread-group-current" ? { ...row, id: "thread-group-foreign-owner" } : row,
        );
      },
      // Bound thread is another bot's DM.
      (data) => {
        data.threads = data.threads!.map((row) =>
          row.id === "thread-group-current" ? { ...row, id: "thread-dm-bot-b" } : row,
        );
      },
      // Bound run no longer matches the bound thread.
      (data) => {
        data.runs = data.runs!.map((row) => ({ ...row, threadId: "thread-dm-bot-b" }));
      },
    ];
    for (const mutate of cases) {
      const data = fixtures();
      mutate(data);
      const source = createBotMemorySource({ prisma: fakePrisma(data), principal: principal() });
      expect(await source.listSessions({ limit: 32 })).toEqual([]);
      expect(
        await source.loadSession(botMemorySessionKey(principal(), "thread-dm"), {}),
      ).toBeNull();
      expect(await source.authorize!("list", null)).toBe(false);
    }
  });

  it("ignores principal mutation after factory binding", async () => {
    const hijacked: Row = principal();
    const source = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: hijacked as ReturnType<typeof principal>,
    });
    hijacked.spaceId = "space-2";
    hijacked.userId = "user-2";
    hijacked.botId = "bot-c";
    hijacked.threadId = "thread-dm-bot-b";
    hijacked.runId = "run-9";
    const keys = sessionRows(await source.listSessions({ limit: 32 })).map((s) => s.sessionKey);
    expect(keys).toHaveLength(3);
    expect(keys).toContain(botMemorySessionKey(principal(), "thread-dm"));
    expect(keys).toContain(botMemorySessionKey(principal(), "thread-group-current"));
  });

  it("reports incomplete list coverage when enumeration or the request cap truncates", async () => {
    const source = createBotMemorySource({
      prisma: fakePrisma(fixtures()),
      principal: principal(),
    });
    const limited = await source.listSessions({ limit: 2 });
    expect("coverage" in limited).toBe(true);
    const limitedPage = limited as MemorySourceListPage;
    expect(limitedPage.coverage).toEqual({ complete: false, reason: "list_limit" });
    expect(limitedPage.sessions).toHaveLength(2);

    const data = fixtures();
    for (let i = 0; i < 26; i += 1) {
      const id = `group-extra-${i}`;
      data.memberships.push({
        botId: "bot-a",
        groupId: id,
        createdAt: new Date(T0.getTime() + i),
        group: {
          id,
          spaceId: "space-1",
          userId: "user-1",
          archivedAt: null,
          name: id,
          thread: {
            id: `thread-${id}`,
            spaceId: "space-1",
            userId: "user-1",
            botId: null,
            groupId: id,
            createdAt: T0,
            messages: [{ createdAt: T0 }],
          },
        },
      });
    }
    const capped = createBotMemorySource({ prisma: fakePrisma(data), principal: principal() });
    const cappedPage = (await capped.listSessions({ limit: 100 })) as MemorySourceListPage;
    expect(cappedPage.coverage).toEqual({ complete: false, reason: "max_group_sessions" });
    // 25 capped group slots: the bound current thread dedupes one membership,
    // plus current and DM roles.
    expect(cappedPage.sessions).toHaveLength(26);
  });

  it("reports incomplete snapshot coverage for char, clip, and unrendered bounds", async () => {
    const dmKey = botMemorySessionKey(principal(), "thread-dm");

    // Session char budget exceeded.
    const chars = fixtures();
    chars.messages = chars.messages!.filter((row) => row.threadId !== "thread-dm");
    for (let seq = 0; seq < 40; seq += 1)
      chars.messages.push(message("thread-dm", seq, [{ kind: "text", text: "x".repeat(9000) }]));
    const charsSource = createBotMemorySource({
      prisma: fakePrisma(chars),
      principal: principal(),
    });
    const charsSnapshot = (await charsSource.loadSession(dmKey, {}))!;
    expect(charsSnapshot.coverage).toEqual({ complete: false, reason: "session_chars" });
    expect(charsSnapshot.records.filter((entry) => entry.type === "message").at(-1)?.id).toBe(
      "rakazo-m39",
    );

    // Redaction expands one message past the per-message cap: never silent.
    const clipped = fixtures();
    const clippedSource = createBotMemorySource({
      prisma: fakePrisma(clipped),
      principal: principal(),
      redact: () => "r".repeat(9000),
    });
    const clippedSnapshot = (await clippedSource.loadSession(dmKey, {}))!;
    expect(clippedSnapshot.coverage).toEqual({ complete: false, reason: "message_chars" });

    // Unrendered block projections are reported, not passed off as complete.
    const unrendered = fixtures();
    unrendered.messages!.push(message("thread-dm", 9, [{ kind: "widget", text: "hello" }]));
    const unrenderedSource = createBotMemorySource({
      prisma: fakePrisma(unrendered),
      principal: principal(),
    });
    const unrenderedSnapshot = (await unrenderedSource.loadSession(dmKey, {}))!;
    expect(JSON.stringify(unrenderedSnapshot.records)).toContain("[unrendered widget block]");
    expect(unrenderedSnapshot.coverage).toEqual({ complete: false, reason: "unrendered_blocks" });
  });

  it("fails a load closed when the destination is revoked during the async read", async () => {
    const data = fixtures();
    let read = false;
    const prisma = fakePrisma(data, {
      afterMessageRead: () => {
        if (!read) {
          read = true;
          revokeBoundMembership(data);
        }
      },
    });
    const source = createBotMemorySource({ prisma, principal: principal() });
    expect(
      await source.loadSession(botMemorySessionKey(principal(), "thread-group-current"), {}),
    ).toBeNull();
    // Even the untouched DM is withheld after the mid-read revocation.
    expect(await source.loadSession(botMemorySessionKey(principal(), "thread-dm"), {})).toBeNull();
  });

  it("binds the snapshot revision to the rows actually read, not a later aggregate", async () => {
    const data = fixtures();
    const prisma = fakePrisma(data, { failAggregate: true });
    const source = createBotMemorySource({ prisma, principal: principal() });
    const dmKey = botMemorySessionKey(principal(), "thread-dm");
    const first = (await source.loadSession(dmKey, {}))!;
    const second = (await source.loadSession(dmKey, {}))!;
    expect(first.revision).toBe(second.revision);
    expect(JSON.stringify(first.records)).toContain("prior DM output Q-7 results");
  });

  it("redacts group titles in metadata and origin records", async () => {
    const data = fixtures();
    const source = createBotMemorySource({
      prisma: fakePrisma(data),
      principal: principal(),
      redact: (text) => text.replaceAll("sk-live-alpha", "[redacted]"),
    });
    const page = await source.listSessions({ limit: 32 });
    expect(JSON.stringify(page)).not.toContain("sk-live-alpha");
    const current = sessionRows(page).find(
      (session) => session.sessionKey === botMemorySessionKey(principal(), "thread-group-current"),
    )!;
    expect(current.metadata?.title).toContain("[redacted]");
    const snapshot = (await source.loadSession(current.sessionKey, {}))!;
    expect(JSON.stringify(snapshot.records)).not.toContain("sk-live-alpha");
    expect((snapshot.records[0]!.data as Row).title).toContain("[redacted]");
    // Host-visible metadata still shows the raw title without a redactor.
    const bare = createBotMemorySource({ prisma: fakePrisma(data), principal: principal() });
    const barePage = await bare.listSessions({ limit: 32 });
    expect(JSON.stringify(barePage)).toContain("sk-live-alpha");
  });
});
