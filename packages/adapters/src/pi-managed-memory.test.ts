import { type AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { managedMemoryProvider } from "./pi-managed-memory.js";

function fixture() {
  const manager = SessionManager.inMemory();
  const provider = managedMemoryProvider(
    () =>
      ({
        session: { sessionId: manager.getSessionId(), sessionManager: manager },
      }) as AgentSessionRuntime,
  );
  const add = (text: string) =>
    manager.appendMessage({ role: "user", content: text, timestamp: 0 });
  return { manager, provider, add };
}
describe("managed exact session recall", () => {
  it("continues exact chunks after new journal entries without losing characters", async () => {
    const { manager, provider, add } = fixture();
    const id = add("source".repeat(100));
    let args: Record<string, unknown> = { entryIds: [id], maxChars: 64 };
    let text = "";
    for (let count = 0; count < 100; count++) {
      const result = await provider.invoke("expand", args);
      if (!result.entries) throw new Error("Expected expansion");
      text += result.entries.map((entry) => entry.text).join("");
      if (!result.next) break;
      add("new journal entry");
      args = result.next.args;
    }
    expect(text).toBe(JSON.stringify(manager.getBranch().find((entry) => entry.id === id)));
    await expect(
      provider.invoke("expand", { ...args, sourceHash: "sha256:changed" }),
    ).rejects.toThrow(/source changed/);
  });
  it("rejects foreign sessions and unknown selectors without filesystem discovery", async () => {
    const { provider, add } = fixture();
    add("needle");
    await expect(provider.invoke("recall", { session: "foreign" })).rejects.toThrow(
      /outside current authority/,
    );
    await expect(
      provider.invoke("expand", { entryRange: { first: "missing", last: "missing" } }),
    ).rejects.toThrow(/Unknown source/);
    const result = await provider.invoke("recall", { query: "needle" });
    expect(result).toMatchObject({
      coverage: { complete: true },
      hits: [{ follow: { ref: "memory.expand" } }],
    });
  });
});
