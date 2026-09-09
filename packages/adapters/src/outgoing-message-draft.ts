import type { ConnectedConnector, ConnectorRoute, ConnectorTool } from "@rakazo/adapter-kit";
import type { OutgoingDraftFields } from "@rakazo/contracts";
import {
  type OutgoingDraftMapping,
  type OutgoingDraftRoute,
  outgoingDraftContainsSecret,
  outgoingDraftProjection,
  outgoingDraftRequest,
  providerArgsFromOutgoingDraft,
  validateOutgoingDraftFields,
} from "@rakazo/core/node/outgoing-message-draft";
import { sanitizeConnectorError } from "./connector-safety.js";

export function outgoingDraftDeliveryOutcome(
  result: unknown,
  secrets: string[] = [],
): {
  status: "sent" | "failed" | "uncertain";
  error?: string;
} {
  if (isRecord(result)) {
    const envelopes = [result, result.data, result.details].filter(isRecord);
    const uncertain = envelopes.find((value) => value.uncertain === true);
    if (uncertain) return { status: "uncertain", error: providerError(uncertain, secrets) };
    const failed = envelopes.find(
      (value) =>
        value.isError === true ||
        Boolean(value.error) ||
        value.successful === false ||
        value.success === false ||
        value.ok === false,
    );
    if (failed)
      return {
        status: "failed",
        error: providerError(failed, secrets) ?? "The provider did not confirm delivery.",
      };
    if (
      envelopes.some(
        (value) => value.successful === true || value.success === true || value.ok === true,
      ) ||
      hasDeliveryReceipt(result)
    )
      return { status: "sent" };
  }
  return {
    status: "uncertain",
    error: "The provider result did not confirm delivery.",
  };
}

function providerError(result: Record<string, unknown>, secrets: string[]): string | undefined {
  if (typeof result.error === "string")
    return sanitizeConnectorError(result.error, secrets).slice(0, 500);
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find(
    (item): item is { type: string; text: string } =>
      isRecord(item) && item.type === "text" && typeof item.text === "string",
  )?.text;
  return text ? sanitizeConnectorError(text, secrets).slice(0, 500) : undefined;
}

function hasDeliveryReceipt(result: Record<string, unknown>): boolean {
  for (const value of [
    result,
    isRecord(result.data) ? result.data : undefined,
    isRecord(result.details) ? result.details : undefined,
  ]) {
    if (!value) continue;
    if (typeof value.messageId === "string" && value.messageId.length > 0) return true;
    if (typeof value.message_id === "string" && value.message_id.length > 0) return true;
  }
  return false;
}

export type ResolvedOutgoingMessageDraft = {
  toolName: string;
  args: Record<string, unknown>;
  request: unknown;
  route: ConnectorRoute;
  preview: ReturnType<typeof outgoingDraftProjection>;
};

export function bindOutgoingMessageRoutes(
  tools: ConnectorTool[],
  connections: ConnectedConnector[],
): ConnectorTool[] {
  return tools.map((tool) => {
    if (!outgoingEmailMapping(tool) || !tool.route || tool.route.resourceId) return tool;
    const account = accountForTool(tool, connections);
    if (!account) return tool;
    return {
      ...tool,
      route: { ...tool.route, resourceId: account.id },
    };
  });
}

export function resolveOutgoingMessageDraft(input: {
  tools: ConnectorTool[];
  connections: ConnectedConnector[];
  fields: OutgoingDraftFields;
  ownerUserId: string;
  secrets: string[];
}): ResolvedOutgoingMessageDraft | { error: string } {
  const fieldError = validateOutgoingDraftFields(input.fields);
  if (fieldError) return { error: fieldError };
  if (outgoingDraftContainsSecret(input.fields, input.secrets)) {
    return { error: "Draft fields cannot contain a protected secret." };
  }
  const candidates = input.tools.flatMap((tool) => {
    const mapping = outgoingEmailMapping(tool);
    const route = boundRoute(tool.route);
    const account = accountForTool(tool, input.connections);
    return mapping && route && account ? [{ tool, mapping, route, account }] : [];
  });
  if (candidates.length === 0) {
    return { error: "No supported connected email sending integration is available." };
  }
  if (candidates.length > 1) {
    return {
      error:
        "More than one email sending integration is available; account selection is not supported yet.",
    };
  }
  const selected = candidates[0]!;
  let args: Record<string, unknown>;
  try {
    args = providerArgsFromOutgoingDraft(input.fields, selected.mapping);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Draft fields are invalid." };
  }
  const request = outgoingDraftRequest(selected.route, args, {
    version: 1,
    revision: 1,
    ownerUserId: input.ownerUserId,
    channel: "email",
    account: {
      connector: selected.route.connectorId,
      label: selected.account.displayName,
    },
    mapping: selected.mapping,
  });
  return {
    toolName: selected.tool.name,
    args,
    request,
    route: selected.tool.route!,
    preview: outgoingDraftProjection(request, "pending"),
  };
}

export function outgoingDraftMappingMatchesTool(
  mapping: OutgoingDraftMapping,
  tool: ConnectorTool,
): boolean {
  const current = outgoingEmailMapping(tool);
  return (
    Boolean(current) &&
    Object.keys(current!).length === Object.keys(mapping).length &&
    Object.entries(current!).every(
      ([key, value]) => mapping[key as keyof OutgoingDraftMapping] === value,
    )
  );
}

export function outgoingEmailMapping(tool: ConnectorTool): OutgoingDraftMapping | undefined {
  const routeName = tool.route?.toolName ?? tool.name;
  if (!/(send.*(email|mail)|(email|mail).*send)/i.test(routeName)) return undefined;
  if (/draft|reply|forward/i.test(routeName)) return undefined;
  const schema = tool.inputSchema;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (!properties) return undefined;
  const to =
    "recipient_email" in properties ? "recipient_email" : "to" in properties ? "to" : undefined;
  const body = "body" in properties ? "body" : undefined;
  if (!to || !body || propertyKind(properties[body]) !== "string") return undefined;
  const toKind = recipientKind(properties[to]);
  if (!toKind) return undefined;
  const accountUserKey =
    isRecord(properties.user_id) &&
    properties.user_id.type === "string" &&
    properties.user_id.default === "me"
      ? "user_id"
      : undefined;
  const allowed = new Set([
    to,
    "cc",
    "bcc",
    "subject",
    "body",
    "is_html",
    ...(accountUserKey ? [accountUserKey] : []),
  ]);
  // Explicit reviewed fields override defaults; unused fields must not introduce delivery parameters.
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property) || !("default" in property) || allowed.has(key)) continue;
    const value = property.default;
    if (value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
      return undefined;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  if (required.some((key) => !allowed.has(key))) return undefined;
  if ("is_html" in properties && propertyKind(properties.is_html) !== "boolean") return undefined;
  if ("subject" in properties && propertyKind(properties.subject) !== "string") return undefined;
  const ccKind = "cc" in properties ? recipientKind(properties.cc) : undefined;
  const bccKind = "bcc" in properties ? recipientKind(properties.bcc) : undefined;
  if (("cc" in properties && !ccKind) || ("bcc" in properties && !bccKind)) return undefined;
  return {
    to,
    toKind,
    ...(ccKind ? { cc: "cc", ccKind } : {}),
    ...(bccKind ? { bcc: "bcc", bccKind } : {}),
    ...(propertyKind(properties.subject) === "string" ? { subject: "subject" } : {}),
    body,
    ...(propertyKind(properties.is_html) === "boolean" ? { plainTextKey: "is_html" } : {}),
    ...(accountUserKey ? { accountUserKey } : {}),
  };
}

function accountForTool(
  tool: ConnectorTool,
  connections: ConnectedConnector[],
): ConnectedConnector | undefined {
  if (!tool.route) return undefined;
  const sameConnector = connections.filter(
    (connection) => connection.connectorId === tool.route!.connectorId,
  );
  if (tool.route.resourceId) {
    const resource = sameConnector.filter((connection) => connection.id === tool.route!.resourceId);
    return resource.length === 1 ? resource[0] : undefined;
  }
  const name = normalize(tool.route.toolName);
  const named = sameConnector.filter((connection) =>
    name.includes(normalize(connection.externalId)),
  );
  if (named.length === 1) return named[0];
  return sameConnector.length === 1 ? sameConnector[0] : undefined;
}

function boundRoute(route: ConnectorRoute | undefined): OutgoingDraftRoute | undefined {
  return route?.connectorId && route.resourceId && route.toolName
    ? {
        connectorId: route.connectorId,
        resourceId: route.resourceId,
        toolName: route.toolName,
        ...(route.resourceRevision !== undefined
          ? { resourceRevision: route.resourceRevision }
          : {}),
      }
    : undefined;
}

function recipientKind(value: unknown): "string" | "array" | undefined {
  const kind = propertyKind(value);
  if (kind === "string") return kind;
  if (kind !== "array" || !isRecord((value as Record<string, unknown>).items)) return undefined;
  return propertyKind((value as Record<string, unknown>).items) === "string" ? "array" : undefined;
}

function propertyKind(value: unknown): "string" | "array" | "boolean" | undefined {
  if (!isRecord(value)) return undefined;
  return value.type === "string" || value.type === "array" || value.type === "boolean"
    ? value.type
    : undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
