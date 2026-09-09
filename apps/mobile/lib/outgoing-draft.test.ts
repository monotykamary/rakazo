import { describe, expect, it } from "vitest";
import {
  canMutateOutgoingDraft,
  draftEditorFromFields,
  mapOutgoingDraft,
  outgoingDraftAnswerInput,
  outgoingDraftUpdateInput,
} from "./outgoing-draft";

const rawDraft = {
  kind: "outgoing_message",
  revision: 3,
  hash: "a".repeat(64),
  status: "pending",
  channel: "email",
  canApprove: true,
  ownerUserId: "owner-fixture",
  account: { connector: "mail", label: "Work" },
  fields: {
    to: ["one@example.test", "two@example.test"],
    cc: ["copy@example.test"],
    bcc: [],
    subject: "Status",
    body: "Complete plain-text body\nwith another line.",
  },
  editable: ["to", "cc", "subject", "body"],
  metadata: [{ label: "Priority", value: "Normal" }],
};

describe("mobile outgoing draft", () => {
  it("maps the complete authoritative projection without truncation", () => {
    const draft = mapOutgoingDraft(rawDraft);
    expect(draft).toEqual(rawDraft);
    expect(draft?.fields.body).toContain("another line");
  });

  it("maps root metadata but never infers permission from ownerUserId", () => {
    const draft = mapOutgoingDraft({
      ...rawDraft,
      canApprove: undefined,
      ownerUserId: "user-1",
      metadata: [{ label: "Route", value: "mail/send" }],
    });
    expect(draft?.metadata).toEqual([{ label: "Route", value: "mail/send" }]);
    expect(draft?.canApprove).toBe(false);
    expect(draft && canMutateOutgoingDraft(draft, true)).toBe(false);
  });

  it("gates mutations on pending status, server permission, and the visible waiting run", () => {
    const draft = mapOutgoingDraft(rawDraft)!;
    expect(canMutateOutgoingDraft(draft, true, "owner-fixture")).toBe(true);
    expect(canMutateOutgoingDraft(draft, true, "other-viewer")).toBe(false);
    expect(canMutateOutgoingDraft(draft, true)).toBe(false);
    expect(canMutateOutgoingDraft({ ...draft, status: "sending" }, true, "owner-fixture")).toBe(
      false,
    );
    expect(canMutateOutgoingDraft(draft, false, "owner-fixture")).toBe(false);
  });

  it("builds exact versioned answer and complete update payloads", () => {
    const draft = mapOutgoingDraft(rawDraft)!;
    const editor = {
      ...draftEditorFromFields(draft),
      to: "new@example.test\nsecond@example.test\n",
      cc: "",
      subject: "Updated",
      body: "Edited body",
      // bcc is not editable and must remain the authoritative empty array.
      bcc: "ignored@example.test",
    };
    expect(
      outgoingDraftAnswerInput({
        groupId: "group-1",
        runId: "run-1",
        messageId: "message-1",
        answer: "send",
        draft,
      }),
    ).toEqual({
      groupId: "group-1",
      runId: "run-1",
      messageId: "message-1",
      answer: "send",
      expectedDraft: { revision: 3, hash: "a".repeat(64) },
    });
    expect(
      outgoingDraftUpdateInput({
        botId: "bot-1",
        runId: "run-1",
        messageId: "message-1",
        approvalEffectId: "effect-1",
        draft,
        editor,
      }),
    ).toEqual({
      botId: "bot-1",
      runId: "run-1",
      messageId: "message-1",
      approvalEffectId: "effect-1",
      expectedRevision: 3,
      expectedHash: "a".repeat(64),
      fields: {
        to: ["new@example.test", "second@example.test"],
        cc: [],
        bcc: [],
        subject: "Updated",
        body: "Edited body",
      },
    });
  });

  it("rejects malformed authoritative fields", () => {
    expect(
      mapOutgoingDraft({ ...rawDraft, fields: { ...rawDraft.fields, to: "hidden" } }),
    ).toBeNull();
    expect(mapOutgoingDraft({ ...rawDraft, status: "mystery" })).toBeNull();
  });
});
