import { describe, expect, it } from "vitest";
import { ModelRuntimeScopeSchema } from "./model-runtime.js";

describe("ModelRuntimeScopeSchema", () => {
  it.each([
    { refresh: true },
    { botId: "bot", refresh: true },
    { botId: "bot", threadId: "thread", refresh: true },
    { botId: "bot", threadId: "thread", participantId: "participant", refresh: true },
  ])("accepts refresh for every runtime scope: %j", (scope) => {
    expect(ModelRuntimeScopeSchema.parse(scope)).toEqual(scope);
  });

  it("keeps refresh optional and rejects non-boolean refresh values", () => {
    expect(ModelRuntimeScopeSchema.parse({})).toEqual({});
    expect(ModelRuntimeScopeSchema.safeParse({ botId: "bot", refresh: "yes" }).success).toBe(false);
  });
});
