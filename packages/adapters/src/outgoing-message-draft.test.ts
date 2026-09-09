import type { ConnectedConnector, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  bindOutgoingMessageRoutes,
  outgoingDraftDeliveryOutcome,
  outgoingDraftMappingMatchesTool,
  outgoingEmailMapping,
  resolveOutgoingMessageDraft,
} from "./outgoing-message-draft.js";

const connection: ConnectedConnector = {
  id: "connection-1",
  connectorId: "composio",
  externalId: "GMAIL",
  displayName: "Gmail",
};

function sendTool(properties: Record<string, unknown> = {}): ConnectorTool {
  return {
    name: "GMAIL_SEND_EMAIL",
    description: "Send email",
    route: { connectorId: "composio", toolName: "GMAIL_SEND_EMAIL" },
    inputSchema: {
      type: "object",
      properties: {
        recipient_email: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        is_html: { type: "boolean" },
        ...properties,
      },
      required: ["subject"],
    },
  };
}

describe("outgoing draft delivery privacy", () => {
  it("redacts known secrets before truncating provider errors", () => {
    const secret = `fixture-private-token-${"x".repeat(600)}`;
    expect(outgoingDraftDeliveryOutcome({ error: `Provider failed: ${secret}` }, [secret])).toEqual(
      {
        status: "failed",
        error: "Provider failed: [redacted]",
      },
    );
    expect(
      outgoingDraftDeliveryOutcome({
        isError: true,
        content: [{ type: "text", text: "Bearer fixture-token" }],
      }).error,
    ).toBe("Bearer [redacted]");
  });
  it("does not let a successful transport envelope hide a failed send", () => {
    expect(
      outgoingDraftDeliveryOutcome({ successful: true, data: { ok: false, error: "Rejected" } })
        .status,
    ).toBe("failed");
    expect(outgoingDraftDeliveryOutcome({ ok: true, error: { message: "Rejected" } }).status).toBe(
      "failed",
    );
    expect(outgoingDraftDeliveryOutcome({ successful: true, error: "" }).status).toBe("sent");
  });
});

describe("outgoing message draft resolution", () => {
  it("binds one authorized account and stages exact plain-text provider arguments", () => {
    const tools = bindOutgoingMessageRoutes([sendTool()], [connection]);
    const resolved = resolveOutgoingMessageDraft({
      tools,
      connections: [connection],
      ownerUserId: "user-1",
      secrets: [],
      fields: {
        to: ["to@example.test"],
        cc: ["cc@example.test"],
        bcc: ["bcc@example.test"],
        subject: "Subject",
        body: "Body",
      },
    });
    expect(resolved).toMatchObject({
      toolName: "GMAIL_SEND_EMAIL",
      args: {
        recipient_email: "to@example.test",
        cc: ["cc@example.test"],
        bcc: ["bcc@example.test"],
        subject: "Subject",
        body: "Body",
        is_html: false,
      },
      preview: {
        ownerUserId: "user-1",
        canApprove: true,
        fields: { to: ["to@example.test"], body: "Body" },
      },
    });
    expect(JSON.stringify(resolved)).not.toContain("from");
  });

  it.each([
    ["newline recipient", ["safe@example.test\r\nBcc: hidden@example.test"]],
    ["comma list", ["one@example.test,two@example.test"]],
    ["display-name syntax", ["Person <person@example.test>"]],
  ])("rejects %s", (_name, to) => {
    const resolved = resolveOutgoingMessageDraft({
      tools: bindOutgoingMessageRoutes([sendTool()], [connection]),
      connections: [connection],
      ownerUserId: "user-1",
      secrets: [],
      fields: { to, subject: "Subject", body: "Body" },
    });
    expect(resolved).toEqual({
      error: "Every recipient must be one valid email address without header characters.",
    });
  });

  it("rejects protected secrets before creating a visible persisted preview", () => {
    const resolved = resolveOutgoingMessageDraft({
      tools: bindOutgoingMessageRoutes([sendTool()], [connection]),
      connections: [connection],
      ownerUserId: "user-1",
      secrets: ["protected-value"],
      fields: { to: ["to@example.test"], subject: "Subject", body: "protected-value" },
    });
    expect(resolved).toEqual({ error: "Draft fields cannot contain a protected secret." });
  });

  it("allows inert optional schema fields but rejects hidden defaults and required fields", () => {
    expect(outgoingEmailMapping(sendTool({ attachment: { type: "string" } }))).toBeDefined();
    expect(
      outgoingEmailMapping(sendTool({ attachment: { type: "string", default: "hidden" } })),
    ).toBeUndefined();
    const required = sendTool({ thread_id: { type: "string" } });
    required.inputSchema.required = ["subject", "thread_id"];
    expect(outgoingEmailMapping(required)).toBeUndefined();
  });

  it("overrides known defaults with reviewed fields and binds the current sending account", () => {
    const tool = sendTool({
      user_id: { type: "string", default: "me" },
      attachment: { type: "object", default: null },
      subject: { type: "string", default: "Hidden subject" },
      body: { type: "string", default: "Hidden body" },
      cc: { type: "array", items: { type: "string" }, default: ["hidden@example.test"] },
      is_html: { type: "boolean", default: true },
    });
    const resolved = resolveOutgoingMessageDraft({
      tools: bindOutgoingMessageRoutes([tool], [connection]),
      connections: [connection],
      ownerUserId: "user-1",
      secrets: [],
      fields: { to: ["reviewed@example.test"], body: "Reviewed body" },
    });
    expect(resolved).toMatchObject({
      args: {
        recipient_email: "reviewed@example.test",
        subject: "",
        body: "Reviewed body",
        cc: [],
        bcc: [],
        is_html: false,
        user_id: "me",
      },
      preview: { fields: { to: ["reviewed@example.test"], body: "Reviewed body", cc: [] } },
    });
    expect(JSON.stringify(resolved)).not.toContain("hidden@example.test");
    expect(JSON.stringify(resolved)).not.toContain("Hidden subject");
    expect(
      outgoingEmailMapping(sendTool({ user_id: { type: "string", default: "another-account" } })),
    ).toBeUndefined();
    expect(
      outgoingEmailMapping(sendTool({ to: { type: "string", default: "hidden@example.test" } })),
    ).toBeUndefined();
  });

  it("rechecks live schema semantics before replaying a reviewed draft", () => {
    const mapping = outgoingEmailMapping(sendTool())!;
    expect(outgoingDraftMappingMatchesTool(mapping, sendTool())).toBe(true);
    expect(
      outgoingDraftMappingMatchesTool(mapping, sendTool({ attachment: { type: "string" } })),
    ).toBe(true);
    expect(
      outgoingDraftMappingMatchesTool(
        mapping,
        sendTool({ hidden_bcc: { type: "string", default: "hidden@example.test" } }),
      ),
    ).toBe(false);
    expect(outgoingDraftMappingMatchesTool(mapping, sendTool({ body: { type: "object" } }))).toBe(
      false,
    );
  });

  it("reports sent only for explicit success or a delivery receipt", () => {
    expect(outgoingDraftDeliveryOutcome({ successful: true })).toEqual({ status: "sent" });
    expect(outgoingDraftDeliveryOutcome({ data: { messageId: "message-1" } })).toEqual({
      status: "sent",
    });
    for (const result of [undefined, null, "error: timeout", {}]) {
      expect(outgoingDraftDeliveryOutcome(result)).toEqual({
        status: "uncertain",
        error: "The provider result did not confirm delivery.",
      });
    }
  });

  it("marks explicit and MCP-style errors failed, and interruptions uncertain", () => {
    expect(outgoingDraftDeliveryOutcome({ successful: false })).toEqual({
      status: "failed",
      error: "The provider did not confirm delivery.",
    });
    expect(
      outgoingDraftDeliveryOutcome({
        kind: "agent_tool_result",
        isError: true,
        content: [{ type: "text", text: "Provider rejected the message" }],
      }),
    ).toEqual({ status: "failed", error: "Provider rejected the message" });
    expect(outgoingDraftDeliveryOutcome({ error: "unknown", uncertain: true })).toEqual({
      status: "uncertain",
      error: "unknown",
    });
  });

  it("fails closed when account selection is ambiguous or the route is unavailable", () => {
    const sibling = { ...connection, id: "connection-2" };
    expect(
      resolveOutgoingMessageDraft({
        tools: bindOutgoingMessageRoutes([sendTool()], [connection, sibling]),
        connections: [connection, sibling],
        ownerUserId: "user-1",
        secrets: [],
        fields: { to: ["to@example.test"], body: "Body" },
      }),
    ).toEqual({ error: "No supported connected email sending integration is available." });
  });
});
