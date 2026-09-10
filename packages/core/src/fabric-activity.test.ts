import { describe, expect, it } from "vitest";
import {
  fabricExecutionLabel,
  fabricNestedCalls,
  fabricNestedHeadline,
  normalizeFabricDisplay,
} from "./fabric-activity.js";

describe("fabric nested activity", () => {
  it("coerces display objects and bare strings", () => {
    expect(normalizeFabricDisplay({ name: "Inspect startup", description: "Read the entry" })).toEqual({
      name: "Inspect startup",
      description: "Read the entry",
    });
    expect(normalizeFabricDisplay("Inspect startup")).toEqual({ name: "Inspect startup" });
    expect(normalizeFabricDisplay('{"name":"Inspect startup"}')).toEqual({ name: "Inspect startup" });
  });

  it("pulls nested TypeScript audits before the durable trace", () => {
    expect(
      fabricNestedCalls({
        audits: [
          {
            ref: "pi.read",
            tool: "read",
            provider: "pi",
            success: true,
            args: { path: "src/main.ts", extra: "drop" },
          },
        ],
        trace: { operations: [{ ref: "pi.grep", action: "grep", provider: "pi", outcome: "succeeded" }] },
      }).map(fabricNestedHeadline),
    ).toEqual(["pi.read src/main.ts"]);
  });

  it("pulls Python trace.calls when audits are absent", () => {
    expect(
      fabricNestedCalls({
        trace: {
          calls: [{ ref: "pi.bash", tool: "bash", provider: "pi", args: { command: "bun test" } }],
        },
      }).map(fabricNestedHeadline),
    ).toEqual(["pi.bash bun test"]);
  });

  it("labels fabric_exec from display, then nested tools, then Fabric program", () => {
    expect(fabricExecutionLabel({ name: "read" })).toBeUndefined();
    expect(
      fabricExecutionLabel({
        name: "fabric_exec",
        display: { name: "Inspect startup" },
      }),
    ).toBe("Inspect startup");
    expect(
      fabricExecutionLabel({
        name: "fabric_exec",
        details: { audits: [{ ref: "pi.read", tool: "read", provider: "pi", args: { path: "a.ts" } }] },
      }),
    ).toBe("Fabric program");
    expect(fabricExecutionLabel({ name: "fabric_exec" })).toBe("Fabric program");
  });
});
