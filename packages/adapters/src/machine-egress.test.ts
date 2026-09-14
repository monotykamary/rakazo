import { describe, expect, it, vi } from "vitest";
import { createMachineEgressHub, mergeEgressSnapshot } from "./machine-egress.js";

function peer() {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}

const actor = { spaceId: "space", userId: "user" };

describe("machine egress hub", () => {
  it("closes an open when no desktop is attached", () => {
    const hub = createMachineEgressHub();
    const client = peer();
    const attachment = hub.attachClient({ ...actor, machineId: "office" }, client);
    attachment?.receive({ type: "open", id: 1, host: "example.com", port: 443 });
    expect(client.send).toHaveBeenCalledWith({
      type: "close",
      id: 1,
      error: "Desktop egress is disconnected",
    });
  });

  it("remaps office streams onto the desktop host", () => {
    const hub = createMachineEgressHub();
    const host = peer();
    const client = peer();
    const hostSession = hub.attachHost(actor, host);
    const office = hub.attachClient({ ...actor, machineId: "office" }, client);
    office?.receive({ type: "open", id: 7, host: "127.0.0.1", port: 9 });
    expect(host.send).toHaveBeenCalledWith({ type: "open", id: 1, host: "127.0.0.1", port: 9 });
    hostSession.receive({ type: "ready", id: 1 });
    expect(client.send).toHaveBeenCalledWith({ type: "ready", id: 7 });
    hostSession.receive({ type: "data", id: 1, bytes: new Uint8Array([9]) });
    expect(client.send).toHaveBeenCalledWith({ type: "data", id: 7, bytes: new Uint8Array([9]) });
    expect(hub.snapshot(actor)).toEqual({
      hostConnected: true,
      activeConnections: 1,
      sessionTotal: 1,
    });
  });

  it("rejects a second client for the same office", () => {
    const hub = createMachineEgressHub();
    expect(hub.attachClient({ ...actor, machineId: "office" }, peer())).not.toBeNull();
    expect(hub.attachClient({ ...actor, machineId: "office" }, peer())).toBeNull();
  });

  it("rejects a path-like destination", () => {
    const hub = createMachineEgressHub();
    const client = peer();
    hub.attachHost(actor, peer());
    hub.attachClient({ ...actor, machineId: "office" }, client)?.receive({
      type: "open",
      id: 1,
      host: "example.com/secret",
      port: 443,
    });
    expect(client.send).toHaveBeenCalledWith({
      type: "close",
      id: 1,
      error: "Egress destination is not allowed",
    });
  });
});

describe("mergeEgressSnapshot", () => {
  it("keeps the durable toggle separate from the live host", () => {
    expect(
      mergeEgressSnapshot(
        { enabled: true },
        { hostConnected: false, activeConnections: 0, sessionTotal: 2 },
      ),
    ).toEqual({
      enabled: true,
      hostConnected: false,
      activeConnections: 0,
      sessionTotal: 2,
    });
  });
});
