import type { PortableMemorySource } from "pi-fabric/memory";
import { describe, expect, it } from "vitest";
import { botMemoryClient } from "./bot-memory-client.js";
import { botStartingMemory } from "./bot-starting-memory.js";

function fixture() {
  let visible = true;
  let revision = "one";
  let records: Record<string, unknown>[] = [
    {
      type: "message",
      id: "result",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The offline deployment uses the cobalt queue." }],
        timestamp: 1,
      },
    },
  ];
  const source: PortableMemorySource = {
    interfaceVersion: 1,
    id: "bot-archive",
    authorize: async () => visible,
    listSessions: async () => [
      { sessionKey: "prior-dm", revision, metadata: { updatedAt: Date.now() } },
    ],
    loadSession: async (sessionKey) =>
      visible && sessionKey === "prior-dm" ? { sessionKey, revision, records } : null,
  };
  return {
    source,
    revoke: () => {
      visible = false;
    },
    clear: () => {
      records = [];
      revision = "two";
    },
  };
}

describe("backend portable memory client", () => {
  it("retrieves retained DM output in a fresh group turn without remember or a live Pi session", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const first = botMemoryClient(f.source, signal);
    const page = (await first("recall", { query: "cobalt" })) as any;
    expect(page.error).toBeUndefined();
    expect(page.hits.length).toBeGreaterThan(0);
    const pointer = page.hits.find((hit: any) => hit.follow.ref === "memory.expand").follow;
    expect(pointer.args.source).toBe(f.source.id);
    const restored = botMemoryClient(f.source, signal);
    const expanded = (await restored("expand", pointer.args)) as any;
    expect(expanded.error).toBeUndefined();
    expect(JSON.stringify(expanded.entries)).toContain("cobalt queue");
    const starting = await botStartingMemory(restored, "cobalt deployment", signal);
    expect(starting).toContain("cobalt");
    expect(starting).toContain("memory.expand");
  });

  it("refuses foreign sources and revoked follow pointers", async () => {
    const f = fixture();
    const call = botMemoryClient(f.source, new AbortController().signal);
    expect(await call("sessions", { source: "another-bot" })).toMatchObject({
      error: { code: "source_unauthorized" },
    });
    const page = (await call("recall", { query: "cobalt" })) as any;
    const pointer = page.hits.find((hit: any) => hit.follow.ref === "memory.expand").follow;
    f.revoke();
    expect(await call("expand", pointer.args)).toMatchObject({
      error: { code: "source_unauthorized" },
    });
  });

  it("does not revive cleared messages from process caches", async () => {
    const f = fixture();
    const call = botMemoryClient(f.source, new AbortController().signal);
    const page = (await call("recall", { query: "cobalt" })) as any;
    const pointer = page.hits.find((hit: any) => hit.follow.ref === "memory.expand").follow;
    f.clear();
    expect(await call("expand", pointer.args)).toMatchObject({ error: { code: "stale_pointer" } });
    const fresh = (await call("recall", { query: "cobalt" })) as any;
    expect(fresh.hits).toEqual([]);
  });

  it("checks root abort before archive access", async () => {
    const f = fixture();
    const abort = new AbortController();
    const call = botMemoryClient(f.source, abort.signal);
    abort.abort();
    await expect(call("recall", { query: "cobalt" })).rejects.toThrow();
  });
});
