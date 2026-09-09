import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createConfiguredAgentRuntime,
  LOCAL_PI_EXTERNAL_EFFECTS_MESSAGE,
  mountLocalPiExternalEffectBlocks,
} from "./app.js";

describe("agent runtime composition", () => {
  it("constructs native local Pi", () => {
    const runtime = createConfiguredAgentRuntime({
      agentRuntime: "pi-local",
      localPi: {
        command: "pi",
        cwd: "/tmp/trusted-checkout",
        sessionDir: "/tmp/rakazo-data/pi-sessions",
      },
    });
    expect(runtime.describe().id).toBe("pi-local");
  });

  it("rejects the retired broker-backed Pi runtime with migration guidance", () => {
    expect(() => createConfiguredAgentRuntime({ agentRuntime: "pi", localPi: null })).toThrow(
      "broker-backed model routing is retired",
    );
  });

  it("fails closed when local configuration was not validated", () => {
    expect(() => createConfiguredAgentRuntime({ agentRuntime: "pi-local", localPi: null })).toThrow(
      "validated local Pi configuration",
    );
  });
});

describe("local Pi external effect routes", () => {
  it.each([
    ["POST", "/api/v1/bots/bot/webhook"],
    ["POST", "/api/v1/bots/bot/github"],
    ["POST", "/api/v1/messaging/webhook/slack"],
    ["POST", "/api/v1/phone/webhook"],
    ["GET", "/api/preview/token"],
    ["POST", "/api/preview/token/path"],
  ])("blocks %s %s before an external caller can create host effects", async (method, url) => {
    const app = new Hono();
    mountLocalPiExternalEffectBlocks(app);

    const response = await app.request(url, { method });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: LOCAL_PI_EXTERNAL_EFFECTS_MESSAGE });
  });
});
