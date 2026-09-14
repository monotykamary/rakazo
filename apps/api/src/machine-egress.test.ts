import { describe, expect, it } from "vitest";
import { isMachineEgressUpgrade } from "./machine-egress.js";

describe("machine egress upgrade", () => {
  it("matches the rakazo-egress upgrade token only", () => {
    expect(isMachineEgressUpgrade({ headers: { upgrade: "rakazo-egress" } } as never)).toBe(true);
    expect(isMachineEgressUpgrade({ headers: { upgrade: "websocket" } } as never)).toBe(false);
    expect(isMachineEgressUpgrade({ headers: {} } as never)).toBe(false);
  });
});
