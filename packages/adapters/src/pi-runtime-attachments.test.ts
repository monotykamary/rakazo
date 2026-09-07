import { describe, expect, it } from "vitest";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";

describe("Pi runtime attachments", () => {
  it("forwards current-turn and boundary steering images through actual RPC", async () => {
    const harness = await createRpcHarness();
    let claimed = false;
    try {
      await harness.run({
        currentTurnImages: [
          { name: "shot.png", mimeType: "image/png", data: new Uint8Array([137, 80, 78, 71]) },
        ],
        claimSteering: async () => {
          if (claimed) return [];
          claimed = true;
          return [
            {
              id: "steer",
              messageId: "steer-message",
              text: "Compare",
              images: [
                { name: "other.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
              ],
            },
          ];
        },
      });
      const sent = JSON.stringify(harness.requests);
      expect(sent).toContain("iVBORw==");
      expect(sent).toContain("AQID");
      expect(sent).toContain("Compare");
    } finally {
      await harness.close();
    }
  }, 30000);
});
