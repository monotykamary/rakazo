import type { AgentProcessHost } from "@rakazo/adapters";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredAgentRuntime,
  LOCAL_PI_EXTERNAL_EFFECTS_MESSAGE,
  mountLocalPiExternalEffectBlocks,
} from "./app.js";

const host = { start: vi.fn() } as unknown as AgentProcessHost;

describe("agent runtime composition", () => {
  it("constructs native local Pi without handing it the managed process host", () => {
    const runtime = createConfiguredAgentRuntime(
      {
        agentRuntime: "pi-local",
        localPi: {
          command: "pi",
          cwd: "/tmp/trusted-checkout",
          sessionDir: "/tmp/rakazo-data/pi-sessions",
        },
      },
      host,
    );
    expect(runtime.describe().id).toBe("pi-local");
    expect(host.start).not.toHaveBeenCalled();
  });

  it("fails closed when local configuration was not validated", () => {
    expect(() =>
      createConfiguredAgentRuntime({ agentRuntime: "pi-local", localPi: null }, host),
    ).toThrow("validated local Pi configuration");
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
