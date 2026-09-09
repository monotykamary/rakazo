import type { OutgoingDraftFields, OutgoingMessageDraft } from "@rakazo/contracts";

export const OUTGOING_DRAFT_STATUSES = [
  "pending",
  "sending",
  "sent",
  "discarded",
  "failed",
  "uncertain",
  "unavailable",
] as const;

export type OutgoingDraftStatus = OutgoingMessageDraft["status"];
export type OutgoingDraftEditableField = OutgoingMessageDraft["editable"][number];
export type OutgoingDraftAnswer = "send" | "discard";
export type OutgoingDraftVersion = { revision: number; hash: string };

export type MobileOutgoingDraft = OutgoingMessageDraft;

export type OutgoingDraftEditor = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return [...value];
}

function metadataArray(value: unknown): Array<{ label: string; value: string }> | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const metadata: Array<{ label: string; value: string }> = [];
  for (const item of value) {
    const row = record(item);
    if (!row || typeof row.label !== "string" || typeof row.value !== "string") return null;
    metadata.push({ label: row.label, value: row.value });
  }
  return metadata;
}

/** Normalize the shared projection and fail closed on mutation rights. */
export function mapOutgoingDraft(value: unknown): MobileOutgoingDraft | null {
  const draft = record(value);
  const fields = record(draft?.fields);
  if (!draft || !fields || draft.kind !== "outgoing_message") return null;
  const to = stringArray(fields.to);
  const cc = fields.cc === undefined ? undefined : stringArray(fields.cc);
  const bcc = fields.bcc === undefined ? undefined : stringArray(fields.bcc);
  const metadata = metadataArray(draft.metadata);
  if (
    !to ||
    cc === null ||
    bcc === null ||
    metadata === null ||
    typeof fields.body !== "string" ||
    (fields.subject !== undefined && typeof fields.subject !== "string") ||
    !Number.isInteger(draft.revision) ||
    (draft.revision as number) < 1 ||
    typeof draft.hash !== "string" ||
    draft.hash.length !== 64 ||
    !OUTGOING_DRAFT_STATUSES.includes(draft.status as OutgoingDraftStatus) ||
    draft.channel !== "email" ||
    typeof draft.ownerUserId !== "string" ||
    !draft.ownerUserId
  ) {
    return null;
  }
  const editable = Array.isArray(draft.editable)
    ? draft.editable.filter(
        (field): field is OutgoingDraftEditableField =>
          field === "to" ||
          field === "cc" ||
          field === "bcc" ||
          field === "subject" ||
          field === "body",
      )
    : [];
  const account = record(draft.account);
  return {
    kind: "outgoing_message",
    revision: draft.revision as number,
    hash: draft.hash,
    status: draft.status as OutgoingDraftStatus,
    channel: draft.channel,
    ownerUserId: draft.ownerUserId,
    canApprove: draft.canApprove === true,
    ...(account && typeof account.connector === "string" && typeof account.label === "string"
      ? { account: { connector: account.connector, label: account.label } }
      : {}),
    fields: {
      to,
      ...(cc !== undefined ? { cc } : {}),
      ...(bcc !== undefined ? { bcc } : {}),
      ...(typeof fields.subject === "string" ? { subject: fields.subject } : {}),
      body: fields.body,
    },
    editable: [...new Set(editable)],
    ...(metadata !== undefined ? { metadata } : {}),
    ...(typeof draft.error === "string" ? { error: draft.error } : {}),
  };
}

export function draftEditorFromFields(draft: MobileOutgoingDraft): OutgoingDraftEditor {
  return {
    to: draft.fields.to.join("\n"),
    cc: draft.fields.cc?.join("\n") ?? "",
    bcc: draft.fields.bcc?.join("\n") ?? "",
    subject: draft.fields.subject ?? "",
    body: draft.fields.body,
  };
}

function recipients(value: string): string[] {
  return value
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Build the complete editable provider field set, never a patch. */
export function draftFieldsForUpdate(
  draft: MobileOutgoingDraft,
  editor: OutgoingDraftEditor,
): OutgoingDraftFields {
  const editable = new Set(draft.editable);
  return {
    to: editable.has("to") ? recipients(editor.to) : [...draft.fields.to],
    ...(draft.fields.cc !== undefined || editable.has("cc")
      ? { cc: editable.has("cc") ? recipients(editor.cc) : [...(draft.fields.cc ?? [])] }
      : {}),
    ...(draft.fields.bcc !== undefined || editable.has("bcc")
      ? { bcc: editable.has("bcc") ? recipients(editor.bcc) : [...(draft.fields.bcc ?? [])] }
      : {}),
    ...(draft.fields.subject !== undefined || editable.has("subject")
      ? { subject: editable.has("subject") ? editor.subject : (draft.fields.subject ?? "") }
      : {}),
    body: editable.has("body") ? editor.body : draft.fields.body,
  };
}

export function canMutateOutgoingDraft(
  draft: MobileOutgoingDraft,
  runCanAnswer: boolean,
  viewerUserId?: string,
): boolean {
  return (
    draft.status === "pending" &&
    draft.canApprove &&
    runCanAnswer &&
    Boolean(viewerUserId) &&
    draft.ownerUserId === viewerUserId
  );
}

export function outgoingDraftAnswerInput(input: {
  botId?: string;
  groupId?: string;
  runId: string;
  messageId: string;
  answer: OutgoingDraftAnswer;
  draft: OutgoingDraftVersion;
}) {
  return {
    ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId! }),
    runId: input.runId,
    messageId: input.messageId,
    answer: input.answer,
    expectedDraft: { revision: input.draft.revision, hash: input.draft.hash },
  };
}

export function outgoingDraftUpdateInput(input: {
  botId?: string;
  groupId?: string;
  runId: string;
  messageId: string;
  approvalEffectId: string;
  draft: MobileOutgoingDraft;
  editor: OutgoingDraftEditor;
}) {
  return {
    ...(input.groupId ? { groupId: input.groupId } : { botId: input.botId! }),
    runId: input.runId,
    messageId: input.messageId,
    approvalEffectId: input.approvalEffectId,
    expectedRevision: input.draft.revision,
    expectedHash: input.draft.hash,
    fields: draftFieldsForUpdate(input.draft, input.editor),
  };
}
