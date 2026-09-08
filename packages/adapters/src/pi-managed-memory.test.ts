import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FabricInvocationContext } from "pi-fabric/protocol";
import { describe, expect, it } from "vitest";
import { managedMemoryProvider } from "./pi-managed-memory.js";

const context: FabricInvocationContext = {
  cwd: "/work/fake",
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
};
interface Page {
  entries: { entryId: string; text: string; textRange: { complete: boolean } }[];
  next: { args: Record<string, unknown> } | null;
  error?: { code: string };
}
function fixture() {
  const manager = SessionManager.inMemory("/work/fake");
  let stopped = false;
  const provider = managedMemoryProvider(() => undefined, {
    sessionManager: () => manager,
    stopped: () => stopped,
  });
  const add = (text: string) =>
    manager.appendMessage({ role: "user", content: text, timestamp: 0 });
  const expand = (args: Record<string, unknown>) =>
    provider.invoke("expand", args, context) as Promise<Page>;
  return {
    manager,
    provider,
    add,
    expand,
    pause: () => {
      stopped = true;
    },
  };
}
describe("managed native session memory", () => {
  it("defaults source-less expansion to the explicit manager before runtime exists and pages losslessly", async () => {
    const { provider, add, expand } = fixture();
    const text = "source café 🐚 ".repeat(100);
    const id = add(text);
    expect(await provider.prepareArguments?.("expand", { entryIds: [id] }, context)).toMatchObject({
      session: expect.any(String),
    });
    let page = await expand({ entryIds: [id], maxChars: 64 });
    let collected = "";
    for (let i = 0; i < 100; i++) {
      expect(page.error).toBeUndefined();
      collected += page.entries.map((entry) => entry.text).join("");
      if (!page.next) break;
      expect(page.next.args.source).toBe(provider.sourceId);
      page = await expand(page.next.args);
    }
    expect(page.next).toBeNull();
    expect(collected).toBe(text);
    expect(await expand({ entryRange: { first: 0, last: 0 } })).toMatchObject({
      entries: [{ entryId: id, text }],
    });
  });
  it("keeps original IDs and live branches and rejects stale continuations after append", async () => {
    const { manager, add, expand, provider } = fixture();
    const root = add("root");
    const a = add("alpha ".repeat(100));
    manager.branch(root);
    add("beta");
    manager.branch(a);
    expect(await provider.invoke("recall", { query: "beta" }, context)).toMatchObject({ total: 0 });
    expect(
      await provider.invoke("recall", { query: "beta", branches: "all" }, context),
    ).toMatchObject({ total: 1 });
    const page = await expand({ entryIds: [a], maxChars: 64 });
    expect(page.next).not.toBeNull();
    add("new journal entry");
    expect(await expand(page.next!.args)).toMatchObject({
      entries: [],
      error: { code: "stale_pointer" },
    });
  });
  it("preserves the original header, IDs and selected leaf after checkpoint restore", async () => {
    const { manager, add } = fixture();
    const root = add("root");
    const selected = add("selected");
    manager.branch(root);
    const abandoned = add("abandoned");
    manager.branch(selected);
    const restored = SessionManager.inMemory("/work/fake", undefined, [
      manager.getHeader()!,
      ...manager.getEntries(),
    ]);
    restored.branch(manager.getLeafId()!);
    const provider = managedMemoryProvider(() => undefined, { sessionManager: () => restored });
    expect(restored.getHeader()).toEqual(manager.getHeader());
    expect(await provider.invoke("sessions", {}, context)).toMatchObject({
      sessions: [{ id: manager.getSessionId(), entryCount: 2 }],
    });
    expect(await provider.invoke("expand", { entryIds: [selected] }, context)).toMatchObject({
      entries: [{ entryId: selected, text: "selected" }],
    });
    expect(await provider.invoke("expand", { entryIds: [abandoned] }, context)).toMatchObject({
      entries: [],
      error: { code: "address_not_found" },
    });
    expect(
      await provider.invoke("expand", { entryIds: [abandoned], branches: "all" }, context),
    ).toMatchObject({ entries: [{ entryId: abandoned }] });
    restored.resetLeaf();
    expect(await provider.invoke("sessions", {}, context)).toMatchObject({
      sessions: [{ entryCount: 0 }],
    });
  });
  it("fails closed for foreign sources, sessions, pause and cancellation", async () => {
    const { provider, add, expand, pause } = fixture();
    add("needle");
    await expect(expand({ source: "archive", session: "foreign" })).rejects.toThrow(/authority/);
    expect(await expand({ session: "foreign" })).toMatchObject({
      entries: [],
      error: { code: "session_not_found" },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.invoke("recall", {}, { ...context, signal: controller.signal }),
    ).rejects.toThrow();
    pause();
    await expect(provider.invoke("sessions", {}, context)).rejects.toThrow(/paused/);
  });
});
