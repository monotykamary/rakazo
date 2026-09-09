import { createHash } from "node:crypto";
import type { OutgoingDraftFields, OutgoingMessageDraft } from "@rakazo/contracts";
import { approvalEffectKey, stableJsonValue } from "../approval-effect-key.js";
import { containsSecret } from "../events.js";

export const OUTGOING_DRAFT_MAX_RECIPIENTS = 50;
export const OUTGOING_DRAFT_MAX_SUBJECT_LENGTH = 2_000;
export const OUTGOING_DRAFT_MAX_BODY_LENGTH = 100_000;

export type OutgoingDraftRoute = {
  connectorId: string;
  resourceId: string;
  resourceRevision?: string | number;
  toolName: string;
};

export type OutgoingDraftMapping = {
  to: string;
  toKind: "string" | "array";
  cc?: string;
  ccKind?: "string" | "array";
  bcc?: string;
  bccKind?: "string" | "array";
  subject?: string;
  body: string;
  plainTextKey?: string;
  accountUserKey?: string;
};

export type PersistedOutgoingDraft = {
  version: 1;
  revision: number;
  ownerUserId: string;
  channel: "email";
  account?: { connector: string; label: string };
  mapping: OutgoingDraftMapping;
};

type DraftEnvelope = [
  string,
  "direct",
  { route: OutgoingDraftRoute; args: Record<string, unknown>; draft: PersistedOutgoingDraft },
];

export function outgoingDraftRequest(
  route: OutgoingDraftRoute,
  args: Record<string, unknown>,
  draft: PersistedOutgoingDraft,
): DraftEnvelope {
  const persistedRoute: OutgoingDraftRoute = {
    connectorId: route.connectorId,
    resourceId: route.resourceId,
    toolName: route.toolName,
    ...(route.resourceRevision !== undefined ? { resourceRevision: route.resourceRevision } : {}),
  };
  return ["__rakazoCatalogTool", "direct", { route: persistedRoute, args, draft }];
}

export function parseOutgoingDraftRequest(request: unknown):
  | {
      route: OutgoingDraftRoute;
      args: Record<string, unknown>;
      draft: PersistedOutgoingDraft;
    }
  | undefined {
  if (!Array.isArray(request) || request.length !== 3) return undefined;
  if (request[0] !== "__rakazoCatalogTool" || request[1] !== "direct") return undefined;
  const payload = request[2];
  if (!isRecord(payload) || !isRecord(payload.route) || !isRecord(payload.args)) return undefined;
  const route = payload.route;
  const draft = payload.draft;
  if (
    !isRecord(draft) ||
    draft.version !== 1 ||
    !Number.isInteger(draft.revision) ||
    (draft.revision as number) < 1 ||
    typeof draft.ownerUserId !== "string" ||
    draft.channel !== "email" ||
    !isRecord(draft.mapping) ||
    !validMapping(draft.mapping) ||
    (draft.account !== undefined &&
      (!isRecord(draft.account) ||
        typeof draft.account.connector !== "string" ||
        typeof draft.account.label !== "string")) ||
    typeof route.connectorId !== "string" ||
    typeof route.resourceId !== "string" ||
    typeof route.toolName !== "string" ||
    (route.resourceRevision !== undefined &&
      typeof route.resourceRevision !== "string" &&
      typeof route.resourceRevision !== "number") ||
    !argsMatchMapping(payload.args, draft.mapping as unknown as OutgoingDraftMapping)
  )
    return undefined;
  return {
    route: route as OutgoingDraftRoute,
    args: payload.args,
    draft: draft as PersistedOutgoingDraft,
  };
}

export function validateOutgoingDraftFields(fields: OutgoingDraftFields): string | undefined {
  const lists = [fields.to, fields.cc ?? [], fields.bcc ?? []];
  if (fields.to.length === 0) return "At least one To recipient is required.";
  if (lists.flat().length > OUTGOING_DRAFT_MAX_RECIPIENTS)
    return `At most ${OUTGOING_DRAFT_MAX_RECIPIENTS} recipients are supported.`;
  if (lists.some((values) => values.some((value) => !validMailbox(value))))
    return "Every recipient must be one valid email address without header characters.";
  if (fields.subject && /[\r\n]/.test(fields.subject)) return "Subject cannot contain line breaks.";
  if ((fields.subject?.length ?? 0) > OUTGOING_DRAFT_MAX_SUBJECT_LENGTH)
    return `Subject must be at most ${OUTGOING_DRAFT_MAX_SUBJECT_LENGTH} characters.`;
  if (fields.body.length > OUTGOING_DRAFT_MAX_BODY_LENGTH)
    return `Body must be at most ${OUTGOING_DRAFT_MAX_BODY_LENGTH} characters.`;
  if (!fields.subject?.trim() && !fields.body.trim()) return "A subject or body is required.";
  return undefined;
}

export function providerArgsFromOutgoingDraft(
  fields: OutgoingDraftFields,
  mapping: OutgoingDraftMapping,
): Record<string, unknown> {
  const error = validateOutgoingDraftFields(fields);
  if (error) throw new TypeError(error);
  const args: Record<string, unknown> = {};
  putRecipients(args, mapping.to, mapping.toKind, fields.to);
  if (mapping.cc && mapping.ccKind)
    putRecipients(args, mapping.cc, mapping.ccKind, fields.cc ?? []);
  else if (fields.cc?.length)
    throw new TypeError("This integration does not support CC recipients.");
  if (mapping.bcc && mapping.bccKind)
    putRecipients(args, mapping.bcc, mapping.bccKind, fields.bcc ?? []);
  else if (fields.bcc?.length)
    throw new TypeError("This integration does not support BCC recipients.");
  if (mapping.subject) {
    args[mapping.subject] = fields.subject ?? "";
  } else if (fields.subject?.length) {
    throw new TypeError("This integration does not support subjects.");
  }
  args[mapping.body] = fields.body;
  if (mapping.plainTextKey) args[mapping.plainTextKey] = false;
  if (mapping.accountUserKey) args[mapping.accountUserKey] = "me";
  return args;
}

export function outgoingDraftFieldsFromArgs(
  args: Record<string, unknown>,
  mapping: OutgoingDraftMapping,
): OutgoingDraftFields {
  return {
    to: recipients(args[mapping.to]),
    ...(mapping.cc ? { cc: recipients(args[mapping.cc]) } : {}),
    ...(mapping.bcc ? { bcc: recipients(args[mapping.bcc]) } : {}),
    ...(mapping.subject && typeof args[mapping.subject] === "string"
      ? { subject: args[mapping.subject] as string }
      : {}),
    body: typeof args[mapping.body] === "string" ? (args[mapping.body] as string) : "",
  };
}

export function outgoingDraftContainsSecret(
  fields: OutgoingDraftFields,
  secrets: string[],
): boolean {
  return containsSecret(fields, secrets);
}

export function outgoingDraftHash(request: unknown, revision: number): string {
  return createHash("sha256").update(stableJsonValue({ revision, request })).digest("hex");
}

export function revisedOutgoingDraftRequest(
  runId: string,
  effectKind: string,
  request: unknown,
  fields: OutgoingDraftFields,
): { request: DraftEnvelope; idempotencyKey: string; draft: OutgoingMessageDraft } {
  const parsed = parseOutgoingDraftRequest(request);
  if (!parsed) throw new TypeError("Draft delivery binding is invalid.");
  const revision = parsed.draft.revision + 1;
  const args = providerArgsFromOutgoingDraft(fields, parsed.draft.mapping);
  const next = outgoingDraftRequest(parsed.route, args, { ...parsed.draft, revision });
  return {
    request: next,
    idempotencyKey: approvalEffectKey(runId, effectKind, args),
    draft: outgoingDraftProjection(next, "pending"),
  };
}

export function outgoingDraftProjection(
  request: unknown,
  status: OutgoingMessageDraft["status"],
  error?: string,
): OutgoingMessageDraft {
  const parsed = parseOutgoingDraftRequest(request);
  if (!parsed) throw new TypeError("Draft delivery binding is invalid.");
  const fields = outgoingDraftFieldsFromArgs(parsed.args, parsed.draft.mapping);
  return {
    kind: "outgoing_message",
    revision: parsed.draft.revision,
    hash: outgoingDraftHash(request, parsed.draft.revision),
    status,
    channel: parsed.draft.channel,
    ownerUserId: parsed.draft.ownerUserId,
    canApprove: status === "pending",
    ...(parsed.draft.account ? { account: parsed.draft.account } : {}),
    fields,
    editable: ["to", "cc", "bcc", "subject", "body"].filter((field) => {
      if (field === "cc") return Boolean(parsed.draft.mapping.cc);
      if (field === "bcc") return Boolean(parsed.draft.mapping.bcc);
      if (field === "subject") return Boolean(parsed.draft.mapping.subject);
      return true;
    }) as OutgoingMessageDraft["editable"],
    ...(parsed.draft.mapping.plainTextKey
      ? { metadata: [{ label: "Format", value: "Plain text" }] }
      : {}),
    ...(error ? { error } : {}),
  };
}

function validMapping(value: Record<string, unknown>): boolean {
  if (typeof value.to !== "string" || typeof value.body !== "string") return false;
  if (value.toKind !== "string" && value.toKind !== "array") return false;
  for (const prefix of ["cc", "bcc"] as const) {
    const key = value[prefix];
    const kind = value[`${prefix}Kind`];
    if ((key === undefined) !== (kind === undefined)) return false;
    if (key !== undefined && typeof key !== "string") return false;
    if (kind !== undefined && kind !== "string" && kind !== "array") return false;
  }
  if (value.subject !== undefined && typeof value.subject !== "string") return false;
  if (value.plainTextKey !== undefined && typeof value.plainTextKey !== "string") return false;
  if (value.accountUserKey !== undefined && value.accountUserKey !== "user_id") return false;
  const keys = [
    value.to,
    value.cc,
    value.bcc,
    value.subject,
    value.body,
    value.plainTextKey,
    value.accountUserKey,
  ].filter((key): key is string => typeof key === "string");
  return new Set(keys).size === keys.length;
}

function argsMatchMapping(args: Record<string, unknown>, mapping: OutgoingDraftMapping): boolean {
  const keys = [
    mapping.to,
    mapping.cc,
    mapping.bcc,
    mapping.subject,
    mapping.body,
    mapping.plainTextKey,
    mapping.accountUserKey,
  ].filter((key): key is string => Boolean(key));
  if (Object.keys(args).length !== keys.length || keys.some((key) => !(key in args))) return false;
  const recipientFields = [
    [mapping.to, mapping.toKind],
    [mapping.cc, mapping.ccKind],
    [mapping.bcc, mapping.bccKind],
  ] as const;
  for (const [key, kind] of recipientFields) {
    if (!key || !kind) continue;
    const value = args[key];
    if (kind === "string" && (typeof value !== "string" || (value && !validMailbox(value))))
      return false;
    if (
      kind === "array" &&
      (!Array.isArray(value) ||
        !value.every((recipient) => typeof recipient === "string" && validMailbox(recipient)))
    )
      return false;
  }
  if (typeof args[mapping.body] !== "string") return false;
  if (mapping.subject && typeof args[mapping.subject] !== "string") return false;
  if (mapping.plainTextKey && args[mapping.plainTextKey] !== false) return false;
  if (mapping.accountUserKey && args[mapping.accountUserKey] !== "me") return false;
  return true;
}

function validMailbox(value: string): boolean {
  if (value !== value.trim() || value.length > 320 || /[\r\n,;<>]/.test(value)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function putRecipients(
  args: Record<string, unknown>,
  key: string,
  kind: "string" | "array",
  values: string[],
) {
  if (kind === "string") {
    if (values.length > 1) throw new TypeError(`${key} supports at most one recipient.`);
    args[key] = values[0]?.trim() ?? "";
  } else args[key] = values.map((value) => value.trim());
}

function recipients(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
