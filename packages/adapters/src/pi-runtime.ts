import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type Api,
  clampThinkingLevel,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  Type,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { PiRuntimeCredentialStore, toOAuthCredential } from "./pi-credentials.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";
import { MANAGED_RESERVED_TOOL_NAMES } from "./pi-tool-names.js";

// Built on first use, not at module load: entry points call loadRootEnv() after
// their imports, and ESM hoists those imports, so module-level env reads here
// would run before .env is loaded and miss the local provider entirely.
let catalogModelsCache: Models | undefined;
function catalogModels(): Models {
  catalogModelsCache ??= registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels()));
  return catalogModelsCache;
}
// Reasoning-capable models must not start at "off": for OpenRouter, pi-ai maps
// that to reasoning.effort "none", which 400s on endpoints that mandate
// reasoning (e.g. google/gemini-3.7-flash). Keep a real level when model.reasoning
// is set; plain models stay off.
const REASONING_MODEL_THINKING_LEVEL: ModelThinkingLevel = "medium";
export function thinkingLevelFor(
  model: Model<Api>,
  preferred?: ModelThinkingLevel | null,
): ModelThinkingLevel {
  if (!model.reasoning) return "off";
  if (preferred) return clampThinkingLevel(model, preferred);
  return clampThinkingLevel(model, REASONING_MODEL_THINKING_LEVEL);
}
// Pi forwards these names to OpenAI Responses, whose function-name contract is
// ^[a-zA-Z0-9_-]+$ with a maximum length of 64 characters.
const AGENT_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_AGENT_TOOL_NAME_LENGTH = 64;
const FALLBACK_AGENT_TOOL_NAME = "connector_tool";

/** Optional self-host fuse. Unset, empty, or 0 means unlimited (default). */
export function maxToolCallsPerTurn(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_TOOL_CALLS_PER_TURN?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export { ManagedPiRuntime as PiAgentRuntime } from "./pi-managed-runtime.js";

export function toPiImages(images: AgentRunRequest["currentTurnImages"]) {
  return (images ?? []).map((image) => ({
    type: "image" as const,
    data: Buffer.from(image.data).toString("base64"),
    mimeType: image.mimeType,
  }));
}

export function modelsForRequest(
  request: Pick<AgentRunRequest, "model">,
  provider: string,
): Models {
  const oauth = request.model.oauth;
  if (oauth) {
    const persist = oauth.persist;
    return registerOpenAiCompatibleCatalog(
      registerLocalProvider(
        builtinModels({
          credentials: new PiRuntimeCredentialStore(
            provider,
            toOAuthCredential(oauth.credential),
            persist ? (next) => persist(next) : undefined,
          ),
        }),
      ),
    );
  }
  if (
    provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
    request.model.baseUrl &&
    request.model.id.trim()
  ) {
    const models = registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels()));
    return registerOpenAiCompatibleRuntime(models, {
      modelId: request.model.id,
      baseUrl: request.model.baseUrl,
      reasoning: request.model.reasoning,
      acceptsImages: request.model.acceptsImages,
    });
  }
  return catalogModels();
}

/**
 * Normalize connector names only at the boundary where they are exposed to Pi.
 * Connector execution continues to use the original name captured by toAgentTool.
 */
export function normalizeAgentToolName(name: string): string {
  if (isProviderSafeAgentToolName(name)) return name;
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || FALLBACK_AGENT_TOOL_NAME).slice(0, MAX_AGENT_TOOL_NAME_LENGTH);
}

/**
 * Return one valid, unique model-facing name per connector tool.
 * Existing valid names are reserved first so sanitizing a connector cannot
 * rename or shadow a builtin tool with the same valid name.
 */
const ACTIVITY_DETAIL_LIMIT = 90;

/** One human-readable line describing a tool call, shown live in the thread. */
export function describeToolActivity(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const detail = (value: unknown): string => {
    const text = sanitizeSensitiveText(String(value ?? ""))
      .replaceAll(/\s+/g, " ")
      .trim();
    return text.length > ACTIVITY_DETAIL_LIMIT ? `${text.slice(0, ACTIVITY_DETAIL_LIMIT)}…` : text;
  };
  if (toolName === "shell") return `Running: ${detail(record.command)}`;
  if (toolName === "read_file") return `Reading ${detail(record.path)}`;
  if (toolName === "write_file") return `Writing ${detail(record.path)}`;
  if (toolName === "list_files") return `Listing ${detail(record.path ?? ".")}`;
  if (toolName === "attach_file") return `Attaching ${detail(record.path)}`;
  if (toolName === "open_path") return `Opening ${detail(record.path)}`;
  if (toolName === "render_plot") return "Rendering a chart";
  if (toolName === "add_mcp_server") return `Connecting MCP server: ${detail(record.name)}`;
  if (toolName === "computer_observe") return "Looking at the screen";
  if (toolName === "browser_navigate")
    return `Opening page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "browser_snapshot") return "Reading the page";
  if (toolName === "browser_act") return "Using the page";
  if (toolName === "computer_act") return "Operating the computer";
  if (toolName === "run_subagent") return `Delegating to helper: ${detail(record.name)}`;
  if (toolName === "create_space") return `Creating space: ${detail(record.name)}`;
  if (toolName === "remember") return "Saving a note to memory";
  if (toolName === "web_search") return `Searching the web: ${detail(record.query)}`;
  if (toolName === "web_fetch") return `Reading page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "skill_read") return `Reading skill: ${detail(record.name)}`;
  if (toolName === "skill_create") return `Creating skill: ${detail(record.name ?? "skill")}`;
  if (toolName === "skill_update")
    return `Updating skill: ${detail(record.name ?? record.skillId)}`;
  if (toolName === "skill_delete")
    return `Deleting skill: ${detail(record.name ?? record.skillId)}`;
  if (toolName === "fabric_exec") {
    const display =
      record.display && typeof record.display === "object" && !Array.isArray(record.display)
        ? (record.display as Record<string, unknown>)
        : {};
    const label =
      detail(display.name) ||
      detail(display.description) ||
      (typeof record.display === "string" ? detail(record.display) : "");
    return label || "Running Fabric program";
  }
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Using ${mcp[1]}: ${mcp[2]}`;
  return `Using ${toolName}`;
}

export function normalizeAgentToolNames(tools: readonly ConnectorTool[]): string[] {
  const reservedValidNames = new Set(
    tools.filter((tool) => isProviderSafeAgentToolName(tool.name)).map((tool) => tool.name),
  );
  const usedNames = new Set<string>(MANAGED_RESERVED_TOOL_NAMES);

  return tools.map((tool) => {
    const base = normalizeAgentToolName(tool.name);
    const originalIsValid =
      isProviderSafeAgentToolName(tool.name) && !MANAGED_RESERVED_TOOL_NAMES.has(tool.name);
    let candidate = base;

    if (usedNames.has(candidate) || (!originalIsValid && reservedValidNames.has(candidate))) {
      candidate = withToolNameSuffix(base, stableToolNameHash(tool.name));
    }

    let suffix = 2;
    while (usedNames.has(candidate) || (!originalIsValid && reservedValidNames.has(candidate))) {
      candidate = withToolNameSuffix(base, `${stableToolNameHash(tool.name)}_${suffix}`);
      suffix += 1;
    }

    usedNames.add(candidate);
    return candidate;
  });
}

function isProviderSafeAgentToolName(name: string): boolean {
  return AGENT_TOOL_NAME_PATTERN.test(name) && name.length <= MAX_AGENT_TOOL_NAME_LENGTH;
}

function withToolNameSuffix(base: string, suffix: string): string {
  const suffixWithSeparator = `_${suffix}`;
  const prefixLength = Math.max(1, MAX_AGENT_TOOL_NAME_LENGTH - suffixWithSeparator.length);
  return `${base.slice(0, prefixLength)}${suffixWithSeparator}`;
}

function stableToolNameHash(name: string): string {
  let hash = 2166136261;
  for (const character of name) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function parametersFor(tool: ConnectorTool) {
  return builtinParameters(tool) ?? safeJsonSchemaParameters(tool);
}

/** A remote MCP server controls its own schemas, so a shape TypeBox cannot express must
 * degrade to a permissive object instead of failing every turn for the whole bot. */
function safeJsonSchemaParameters(tool: ConnectorTool) {
  try {
    return jsonSchemaParameters(tool.inputSchema);
  } catch (error) {
    getLogger().error(`unsupported input schema for tool ${tool.name}`, error);
    return Type.Object({});
  }
}

function builtinParameters(tool: ConnectorTool) {
  if (tool.name === "write_file") {
    return Type.Object({ path: Type.String(), content: Type.String() });
  }
  if (tool.name === "destination.write") {
    return Type.Object({
      collection: Type.String(),
      title: Type.String(),
      body: Type.String(),
    });
  }
  if (tool.name === "request_takeover") {
    return Type.Object({ reason: Type.String() });
  }
  if (tool.name === "request_secret") {
    return Type.Object({
      label: Type.String(),
      purpose: Type.Union([Type.Literal("otp"), Type.Literal("password"), Type.Literal("api_key")]),
      connectionId: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "ask_user") {
    return Type.Object({
      question: Type.String({ maxLength: 240 }),
      options: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
        minItems: 2,
        maxItems: 4,
        uniqueItems: true,
      }),
    });
  }
  if (tool.name === "remember") {
    return Type.Object({ content: Type.String(), path: Type.String() });
  }
  if (tool.name === "shell") {
    return Type.Object({
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "run_subagent") {
    return Type.Object({
      name: Type.String(),
      task: Type.String(),
      instructions: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      worktree: Type.Optional(Type.Boolean()),
      worktreeId: Type.Optional(Type.String()),
      participantId: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "spawn_bot") {
    return Type.Object({
      name: Type.String(),
      title: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      computer_mode: Type.Optional(Type.Union([Type.Literal("team"), Type.Literal("dedicated")])),
    });
  }
  if (tool.name === "create_space") {
    return Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }) });
  }
  if (tool.name === "archive_bot" || tool.name === "delete_bot") {
    return Type.Object({
      confirm_name: Type.String(),
      bot_id: Type.Optional(Type.String()),
    });
  }
  return undefined;
}

/** Keep recent visual state without repeatedly resending every earlier full screenshot. */
export function pruneComputerScreenshotContext(
  messages: AgentMessage[],
  screenshotsToKeep = 2,
): AgentMessage[] {
  let remaining = Math.max(0, screenshotsToKeep);
  let transformed: AgentMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isComputerScreenshotMessage(message)) continue;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    transformed ??= [...messages];
    transformed[index] = {
      ...message,
      content: message.content.filter((part) => part.type !== "image"),
    };
  }
  return transformed ?? messages;
}

function isComputerScreenshotMessage(
  message: AgentMessage | undefined,
): message is Extract<AgentMessage, { role: "toolResult" }> {
  if (message?.role !== "toolResult" || !message.content.some((part) => part.type === "image")) {
    return false;
  }
  const details = message.details;
  return Boolean(
    details &&
      typeof details === "object" &&
      "frameId" in details &&
      typeof (details as { frameId?: unknown }).frameId === "string",
  );
}

export function jsonSchemaParameters(schema: Record<string, unknown>) {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields: Record<string, ReturnType<typeof Type.Optional>> = {};
  for (const [key, spec] of Object.entries(properties)) {
    const field = jsonField(spec);
    fields[key] = (required.has(key) ? field : Type.Optional(field)) as unknown as ReturnType<
      typeof Type.Optional
    >;
  }
  return Type.Object(fields);
}

/** TypeBox only builds literals from primitives; anything else throws while the tool list is
 * being assembled, which would take down the whole turn. */
function enumUnion(values: readonly unknown[]) {
  const members = values.map((value) =>
    value === null
      ? Type.Null()
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? Type.Literal(value)
        : undefined,
  );
  return members.every((member) => member !== undefined) ? Type.Union(members) : undefined;
}

function jsonField(spec: unknown): ReturnType<typeof Type.String> {
  const definition = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  if (Array.isArray(definition.enum) && definition.enum.length > 0) {
    const union = enumUnion(definition.enum);
    if (union) return union as never;
  }
  const type = "type" in definition ? String(definition.type) : "string";
  if (type === "number" || type === "integer") return Type.Number() as never;
  if (type === "boolean") return Type.Boolean() as never;
  if (type === "array") {
    const options: {
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
    } = {};
    if (typeof definition.minItems === "number") options.minItems = definition.minItems;
    if (typeof definition.maxItems === "number") options.maxItems = definition.maxItems;
    if (definition.uniqueItems === true) options.uniqueItems = true;
    return Type.Array(jsonField(definition.items), options) as never;
  }
  if (type === "object") return jsonSchemaParameters(definition) as never;
  return Type.String();
}

function sanitizeSensitiveText(message: string) {
  return message
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"',;&]+/gi, "Bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s"',;&]+/gi,
      "$1[redacted]",
    )
    .replace(/((?:auth|authorization)\s*[=:]\s*)(?!Bearer\b)[^\s"',;&]+/gi, "$1[redacted]");
}

/** Origin + path only for activity chips; drop userinfo, query, and fragment. */
function redactActivityUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Never echo unparsed input — it may still contain userinfo/secrets.
    return "[invalid URL]";
  }
}

/** Stable affinity for a bot conversation or one delegated participant. */
export function conversationSessionId(threadId: string, botId: string, agentId?: string): string {
  return agentId ? `${threadId}:${botId}:${agentId}` : `${threadId}:${botId}`;
}

export function reliableStreamOptions(
  model: Pick<Model<Api>, "api" | "provider">,
  options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
  let next = options;
  if (model.provider === "openai-codex" || model.api === "openai-codex-responses") {
    // Pi cannot fall back after a WebSocket has emitted its start event. SSE
    // avoids long-lived sockets between tool turns and has bounded retries.
    next = { ...next, transport: "sse" };
  }
  // These protocols require affinity headers that Pi 0.85.1 does not attach.
  if (model.provider === "opencode" || model.provider === "opencode-go") {
    const sessionId = next?.sessionId?.trim() || randomUUID();
    next = {
      ...next,
      sessionId,
      headers: {
        "x-opencode-session": sessionId,
        "x-opencode-client": "rakazo",
        ...next?.headers,
      },
    };
  }
  return next;
}
