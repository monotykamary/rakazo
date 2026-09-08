import { createMachinesService, createMemoryMachineStore } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountMachineRunnerRoutes } from "./machines.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

function makeApp() {
  const store = createMemoryMachineStore();
  const machines = createMachinesService({ store });
  const app = new Hono();
  mountMachineRunnerRoutes(app, { machines });
  return { app, machines };
}

describe("machine runner HTTP routes", () => {
  it("rejects non-object JSON before inspecting credentials or version fields", async () => {
    const { app, machines } = makeApp();
    const start = await machines.startPairing(actor, { name: "workshop" });
    const paired = await machines.pair({ code: start.code });
    for (const body of ["null", "[]", "5", '"text"']) {
      for (const path of ["pair", "poll", "heartbeat", "commands/unused/result"]) {
        const response = await app.request(`/api/machines/runner/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${paired.token}` },
          body,
        });
        expect(response.status).toBe(400);
      }
    }
  });
  it("pairs a runner from a single-use code and rejects reuse", async () => {
    const { app, machines } = makeApp();
    const started = await machines.startPairing(actor, { name: "laptop" });
    const ok = await app.request("/api/machines/runner/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: started.code, version: "1.0" }),
    });
    expect(ok.status).toBe(200);
    const paired = (await ok.json()) as { machineId: string; token: string };
    expect(paired.machineId).toBe(started.pairingId);

    const replay = await app.request("/api/machines/runner/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: started.code }),
    });
    // Single use: the hash is cleared on use, so reuse reads as invalid.
    expect(replay.status).toBe(401);

    const bad = await app.request("/api/machines/runner/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "rk_p_bogusbogusbogusbogusbogusbogusbogusbogus1" }),
    });
    expect(bad.status).toBe(401);
  });

  it("requires a bearer machine token on poll, result, and heartbeat", async () => {
    const { app } = makeApp();
    for (const path of [
      "/api/machines/runner/poll",
      "/api/machines/runner/heartbeat",
      "/api/machines/runner/commands/c1/result",
    ]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    }
  });

  it("delivers exactly one command per poll and accepts one result", async () => {
    const { app, machines } = makeApp();
    const started = await machines.startPairing(actor, { name: "laptop" });
    const pair = await app.request("/api/machines/runner/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: started.code }),
    });
    const { machineId, token } = (await pair.json()) as { machineId: string; token: string };
    const auth = { authorization: `Bearer ${token}` };

    await machines.enqueue({
      machineId,
      method: "GET",
      path: "/agents/ag-1/events",
      query: "cursor=-1",
      scope: { kind: "unscoped" },
    });

    const poll = await app.request("/api/machines/runner/poll", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: "{}",
    });
    expect(poll.status).toBe(200);
    const delivered = (await poll.json()) as {
      command: { id: string; path: string; query: string } | null;
    };
    expect(delivered.command?.path).toBe("/agents/ag-1/events");
    expect(delivered.command?.query).toBe("cursor=-1");

    const empty = await app.request("/api/machines/runner/poll", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: "{}",
    });
    await expect(empty.json()).resolves.toEqual({ command: null });

    const result = await app.request(
      `/api/machines/runner/commands/${delivered.command!.id}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ status: 200, contentType: "application/json", bodyBase64: "e30=" }),
      },
    );
    expect(result.status).toBe(200);

    const replay = await app.request(
      `/api/machines/runner/commands/${delivered.command!.id}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ status: 200 }),
      },
    );
    expect(replay.status).toBe(409);

    const unknown = await app.request("/api/machines/runner/commands/nope/result", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ status: 200 }),
    });
    expect(unknown.status).toBe(404);
  });

  it("heartbeats keep the machine online and fail closed after revocation", async () => {
    const { app, machines } = makeApp();
    const started = await machines.startPairing(actor, { name: "laptop" });
    const pair = await app.request("/api/machines/runner/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: started.code }),
    });
    const { machineId, token } = (await pair.json()) as { machineId: string; token: string };
    const auth = { authorization: `Bearer ${token}` };

    const beat = await app.request("/api/machines/runner/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ version: "1.1" }),
    });
    expect(beat.status).toBe(204);
    const listed = await machines.list(actor);
    expect(listed[0]!.status).toBe("online");
    expect(listed[0]!.version).toBe("1.1");

    await machines.revoke(actor, { machineId });
    const after = await app.request("/api/machines/runner/poll", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: "{}",
    });
    expect(after.status).toBe(401);
  });

  it("rejects oversized pairing bodies", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/machines/runner/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "rk_p_" + "A".repeat(6000) }),
    });
    expect([400, 413]).toContain(res.status);
  });
});
