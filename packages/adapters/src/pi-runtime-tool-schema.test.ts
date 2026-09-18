import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { jsonSchemaParameters, parametersFor } from "./pi-runtime.js";

describe("jsonSchemaParameters", () => {
  it("keeps model-facing nullable parameters compatible with connector validation", () => {
    const tool = {
      name: "catalog_lookup",
      description: "Look up catalog entries",
      inputSchema: {
        type: "object",
        properties: { enabled: { type: ["boolean", "null"] } },
        required: ["enabled"],
        additionalProperties: false,
      },
    };
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    for (const enabled of [true, false, null]) {
      expect(parseConnectorToolArgs(wire, { enabled })).toEqual(
        parseConnectorToolArgs(tool.inputSchema, { enabled }),
      );
    }
    expect(() => parseConnectorToolArgs(wire, { enabled: "false" })).toThrow();
    expect(() => parseConnectorToolArgs(wire, {})).toThrow();
  });

  it("preserves nullable nested objects and closes them", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: {
        filter: {
          type: ["object", "null"],
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
          additionalProperties: false,
        },
      },
      required: ["filter"],
    });
    expect(JSON.parse(JSON.stringify(schema)).properties.filter).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    });
  });

  it("preserves null branches and nullable array items", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: {
        cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
        values: { type: "array", items: { type: ["boolean", "null"] }, minItems: 1 },
      },
    });
    const wire = JSON.parse(JSON.stringify(schema)).properties;
    expect(wire.cursor).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(wire.values).toEqual({
      type: "array",
      minItems: 1,
      items: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    });
  });

  it("keeps primitive enums as literal unions", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"],
    }) as unknown as { properties: { mode: { anyOf: { const: unknown }[] } } };
    expect(schema.properties.mode.anyOf.map((member) => member.const)).toEqual(["fast", "slow"]);
  });

  it("accepts nullable primitive enums", () => {
    expect(() =>
      jsonSchemaParameters({
        type: "object",
        properties: { cursor: { type: ["string", "null"], enum: ["a", "b", null] } },
      }),
    ).not.toThrow();
  });

  it("does not throw for non-primitive enum members", () => {
    expect(() =>
      jsonSchemaParameters({
        type: "object",
        properties: { filter: { type: "object", enum: [{ kind: "all" }, ["x"]] } },
      }),
    ).not.toThrow();
  });

  it("fails closed for a malformed remote schema", () => {
    const parameters = parametersFor({
      name: "malformed",
      description: "Malformed",
      inputSchema: { type: "object", properties: [] },
    });
    expect(JSON.parse(JSON.stringify(parameters))).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(() =>
      validateToolArguments(
        { name: "malformed", description: "Malformed", parameters },
        { type: "toolCall", id: "bad", name: "malformed", arguments: { unexpected: true } },
      ),
    ).toThrow("Validation failed");
  });
});
