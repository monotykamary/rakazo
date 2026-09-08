import { describe, expect, it } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";

describe("Pi runtime cancellation", () => {
  it.each(["return", "abort", "external", "throw"] as const)(
    "reaps actual quiet RPC work with %s",
    async (method) => {
      const harness = await createRpcHarness({ quiet: true });
      const controller = new AbortController();
      const stream = harness.runtime.run(harness.request, {
        spaceId: "space",
        signal: controller.signal,
      });
      const next = stream.next();
      try {
        await expect.poll(() => harness.requests.length, { timeout: 15000 }).toBe(1);
        if (method === "return") await stream.return!();
        else if (method === "abort") await harness.runtime.abort(harness.request.runId);
        else if (method === "external") controller.abort();
        else
          await expect(stream.throw!(new Error("consumer failed"))).rejects.toThrow(
            "consumer failed",
          );
        await next;
        await stream.return!();
        expect(harness.host.reaped).toBe(1);
        if (method !== "external") expect(controller.signal.aborted).toBe(false);
      } finally {
        await harness.close();
      }
    },
    30000,
  );
  it("rejects sibling tool dispatch after lease loss or cancellation", async () => {
    const harness = await createRpcHarness();
    const controller = new AbortController();
    let calls = 0;
    const input = {
      ...harness.request,
      tools: [
        {
          name: "read_file",
          description: "Read",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      executeTool: async () => {
        calls++;
      },
    };
    const bridge = new ToolBridge(
      input,
      new RunAuthority(input, controller.signal),
      () => undefined,
    );
    controller.abort();
    try {
      await expect(
        bridge.invoke({
          handle: bridge.catalog[0]!.handle,
          callId: "late",
          args: { path: "notes.txt" },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      await harness.close();
    }
  });
  it("does not spawn any process when cancelled before setup", async () => {
    const harness = await createRpcHarness();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        harness.runtime.run(harness.request, { signal: controller.signal }).next(),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(harness.host.starts).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
