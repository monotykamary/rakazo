import { describe, expect, it } from "vitest";
import {
  isOfficeReplicaLeaseOwner,
  machineSupportsOfficeReplica,
  OFFICE_REPLICA_VERSION_MARK,
  officeReplicaLeaseOwner,
} from "./office-replica.js";

describe("office replica identity", () => {
  it("recognizes runner heartbeats that advertise ownership", () => {
    expect(machineSupportsOfficeReplica(`0.2.0+${OFFICE_REPLICA_VERSION_MARK}`)).toBe(true);
    expect(machineSupportsOfficeReplica("0.1.0")).toBe(false);
    expect(machineSupportsOfficeReplica(null)).toBe(false);
  });

  it("fences laptop workers off office-owned leases", () => {
    const owner = officeReplicaLeaseOwner("replica1");
    expect(owner).toBe("office:replica1");
    expect(isOfficeReplicaLeaseOwner(owner)).toBe(true);
    expect(isOfficeReplicaLeaseOwner("worker-a")).toBe(false);
    expect(isOfficeReplicaLeaseOwner(null)).toBe(false);
  });
});
