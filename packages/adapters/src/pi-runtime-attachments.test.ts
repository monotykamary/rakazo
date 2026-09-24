import { describe, expect, it } from "vitest";
import { createRpcHarness, RPC_TEST_IMAGES } from "./pi-rpc-test-emulator.js";

describe("Pi runtime attachments", () => {
  it("forwards current-turn and boundary steering images through actual RPC", async () => {
    const harness = await createRpcHarness();
    let claimed = false;
    try {
      await harness.run({
        currentTurnImages: [
          { name: "shot.png", mimeType: "image/png", data: RPC_TEST_IMAGES.root },
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
                { name: "other.png", mimeType: "image/png", data: RPC_TEST_IMAGES.steering },
              ],
            },
          ];
        },
      });
      const sent = JSON.stringify(harness.requests);
      expect(sent).toContain(RPC_TEST_IMAGES.root.toString("base64"));
      expect(sent).toContain(RPC_TEST_IMAGES.steering.toString("base64"));
      expect(sent).toContain("Compare");
    } finally {
      await harness.close();
    }
  }, 30000);
});
