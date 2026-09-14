import { describe, expect, it } from "vitest";
import { applyLocalContainerEnv, mockerDockerHost } from "./local-container.ts";

describe("applyLocalContainerEnv", () => {
  it("points darwin Docker-API clients at mocker when the socket exists", () => {
    const env: NodeJS.ProcessEnv = {};
    applyLocalContainerEnv(env, {
      platform: "darwin",
      home: "/tmp/rakazo-home",
      socketExists: () => true,
    });
    expect(env.DOCKER_HOST).toBe(mockerDockerHost("/tmp/rakazo-home"));
    expect(env.TESTCONTAINERS_RYUK_DISABLED).toBe("true");
  });

  it("leaves an explicit DOCKER_HOST alone", () => {
    const env: NodeJS.ProcessEnv = { DOCKER_HOST: "unix:///tmp/custom.sock" };
    applyLocalContainerEnv(env, {
      platform: "darwin",
      home: "/tmp/rakazo-home",
      socketExists: () => true,
    });
    expect(env.DOCKER_HOST).toBe("unix:///tmp/custom.sock");
    expect(env.TESTCONTAINERS_RYUK_DISABLED).toBeUndefined();
  });

  it("does not change Linux", () => {
    const env: NodeJS.ProcessEnv = {};
    applyLocalContainerEnv(env, {
      platform: "linux",
      home: "/tmp/rakazo-home",
      socketExists: () => true,
    });
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it("leaves darwin alone when mocker serve is not running", () => {
    const env: NodeJS.ProcessEnv = {};
    applyLocalContainerEnv(env, {
      platform: "darwin",
      home: "/tmp/rakazo-home",
      socketExists: () => false,
    });
    expect(env.DOCKER_HOST).toBeUndefined();
  });
});
