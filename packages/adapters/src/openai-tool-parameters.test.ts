import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  normalizeOpenAiToolParameters,
  openAiToolParametersNeedNormalization,
} from "./openai-tool-parameters.js";
import { parametersFor } from "./pi-runtime.js";

describe("normalizeOpenAiToolParameters", () => {
  it("adds the object envelope without changing a union", () => {
    const anyOf = [
      { type: "object", properties: { credential: { type: "object" } } },
      { type: "object", properties: { connectionId: { type: "string" } } },
    ];
    expect(normalizeOpenAiToolParameters({ anyOf })).toEqual({
      type: "object",
      properties: {},
      anyOf,
    });
  });

  it("keeps complete object schemas unchanged", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    };
    expect(normalizeOpenAiToolParameters(schema)).toEqual(schema);
    expect(openAiToolParametersNeedNormalization(schema)).toBe(false);
  });

  it("turns malformed envelopes into deterministic empty object envelopes", () => {
    for (const schema of [undefined, null, [], { type: "string" }, { properties: [] }]) {
      expect(normalizeOpenAiToolParameters(schema)).toMatchObject({
        type: "object",
        properties: {},
      });
      expect(openAiToolParametersNeedNormalization(schema)).toBe(true);
    }
  });
});

describe("parametersFor OpenAI wire fidelity", () => {
  it.each(["list_secrets", "request_secret"])("wraps %s in an object envelope", (name) => {
    const tool = builtinAgentTools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`missing ${name}`);
    const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as {
      type?: unknown;
      properties?: unknown;
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    expect(wire.type).toBe("object");
    expect(wire.properties).toEqual({});
    if (name === "request_secret") expect(wire.anyOf ?? wire.oneOf).toHaveLength(2);
  });
});
