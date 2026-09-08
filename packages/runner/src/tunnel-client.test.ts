import { describe, expect, it } from "vitest";
import { TunnelClient } from "./tunnel-client.js";

describe("runner control request cancellation", () => {
  it.each(["poll", "result", "heartbeat"] as const)(
    "aborts an in-flight %s request",
    async (operation) => {
      let observed: AbortSignal | null | undefined;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const client = new TunnelClient({
        serverUrl: "https://server.example",
        fetch: async (_input, init) => {
          observed = init?.signal;
          await gate;
          return Response.json({ command: null });
        },
      });
      const controller = new AbortController();
      const request =
        operation === "poll"
          ? client.poll("test-token", 0, controller.signal)
          : operation === "result"
            ? client.postResult("test-token", "command", { status: 200 }, controller.signal)
            : client.heartbeat("test-token", controller.signal);
      const outcome = request.then(
        () => null,
        (error) => error,
      );
      try {
        controller.abort();
        expect(observed?.aborted).toBe(true);
        release();
        expect(await outcome).toMatchObject({ name: "AbortError" });
      } finally {
        release();
        await outcome;
      }
    },
  );
});
