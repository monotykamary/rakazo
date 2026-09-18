import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { RunAuthority, ToolBridge } from "./pi-rpc-tool-bridge.js";
import { jsonField, jsonSchemaParameters, parametersFor } from "./pi-runtime.js";

function toolNamed(name: string) {
  const tool = builtinAgentTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing builtin tool ${name}`);
  return tool;
}

function requestSecretSchema() {
  return toolNamed("request_secret").inputSchema as Record<string, unknown>;
}

function oneOfBranches(schema: Record<string, unknown>) {
  return (Array.isArray(schema.oneOf) ? schema.oneOf : []) as Array<{
    properties?: Record<string, { properties?: Record<string, unknown> }>;
    required?: string[];
    additionalProperties?: unknown;
  }>;
}

const sampleCredential = {
  name: "example_token",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};

describe("request_secret schema fidelity", () => {
  it("retains credential XOR connectionId and closed branches", () => {
    const branches = oneOfBranches(requestSecretSchema());
    const credential = branches.find((branch) => branch.required?.includes("credential"));
    const connection = branches.find((branch) => branch.required?.includes("connectionId"));
    expect(Object.keys(credential?.properties?.credential?.properties ?? {}).sort()).toEqual([
      "auth",
      "name",
      "origin",
    ]);
    expect(connection?.properties).toHaveProperty("connectionId");
    expect(branches).toHaveLength(2);
    expect(branches.every((branch) => branch.additionalProperties === false)).toBe(true);
  });

  it("rejects both destinations, neither destination, and replace on connectionId", () => {
    const schema = requestSecretSchema();
    for (const args of [
      { label: "Token", purpose: "api_key", credential: sampleCredential, connectionId: "c" },
      { label: "Token", purpose: "api_key" },
      { label: "Code", purpose: "otp", connectionId: "c", replace: true },
    ]) {
      expect(() => parseConnectorToolArgs(schema, args)).toThrow();
    }
  });

  it("preserves union, const discriminators, and closed variants for Pi", () => {
    const wire = JSON.parse(JSON.stringify(parametersFor(toolNamed("request_secret")))) as {
      type?: unknown;
      properties?: unknown;
      anyOf?: Array<{ additionalProperties?: unknown }>;
    };
    expect(wire.type).toBe("object");
    expect(wire.properties).toEqual({});
    expect(wire.anyOf).toHaveLength(2);
    expect(wire.anyOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(JSON.stringify(wire)).toContain('"const":"bearer"');
    expect(JSON.stringify(jsonField({ type: "string", const: "header" }))).toContain(
      '"const":"header"',
    );
    expect(JSON.stringify(jsonSchemaParameters(requestSecretSchema()))).toContain('"anyOf"');
  });

  it("preserves credential and replace through native RPC dispatch", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const tool = toolNamed("request_secret");
    const request: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: "run",
      prompt: "save it",
      instructions: "test",
      history: [],
      tools: [tool],
      model: { provider: "test", id: "test" },
      executeTool,
    };
    const events: AgentRuntimeEvent[] = [];
    const bridge = new ToolBridge(
      request,
      new RunAuthority(request, new AbortController().signal),
      (event) => events.push(event),
    );
    const args = {
      label: "Example token",
      purpose: "api_key",
      credential: sampleCredential,
      replace: true,
    };
    await bridge.invoke({ handle: bridge.catalog[0]?.handle, callId: "secret", args });
    expect(executeTool).toHaveBeenCalledWith(
      "request_secret",
      args,
      expect.any(String),
      undefined,
      expect.any(AbortSignal),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", args }));
    expect(() =>
      bridge.invoke({
        handle: bridge.catalog[0]?.handle,
        callId: "invalid-secret",
        args: { ...args, connectionId: "connection" },
      }),
    ).toThrow("Validation failed");
    expect(executeTool).toHaveBeenCalledOnce();
  });
});
