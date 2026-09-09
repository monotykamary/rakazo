import { describe, expect, it } from "vitest";
import {
  outgoingDraftHash,
  outgoingDraftProjection,
  outgoingDraftRequest,
} from "./outgoing-message-draft.js";

describe("outgoing draft persistence", () => {
  it("keeps its CAS hash across a JSON database round trip", () => {
    const request = outgoingDraftRequest(
      { connectorId: "composio", resourceId: "connection-1", toolName: "GMAIL_SEND_EMAIL" },
      {
        recipient_email: "person@example.test",
        subject: "Hello",
        body: "Body",
        cc: [],
        bcc: [],
        is_html: false,
      },
      {
        version: 1,
        revision: 1,
        ownerUserId: "user-1",
        channel: "email",
        account: { connector: "composio", label: "Gmail" },
        mapping: {
          to: "recipient_email",
          toKind: "string",
          cc: "cc",
          ccKind: "array",
          bcc: "bcc",
          bccKind: "array",
          subject: "subject",
          body: "body",
          plainTextKey: "is_html",
        },
      },
    );
    const stored = JSON.parse(JSON.stringify(request));
    expect(outgoingDraftHash(stored, 1)).toBe(outgoingDraftHash(request, 1));
    expect(outgoingDraftProjection(stored, "pending").hash).toBe(
      outgoingDraftProjection(request, "pending").hash,
    );
  });
});
