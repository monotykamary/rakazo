import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const emulatorSource = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cwd = process.cwd();
const scenarioPath = join(cwd, "pi-local-scenario.json");
const logPath = join(cwd, "pi-local-emulator.jsonl");
const scenario = JSON.parse(await readFile(scenarioPath, "utf8").catch(() => "{}"));
const log = (value) => appendFile(logPath, JSON.stringify(value) + "\\n");

if (process.argv.includes("--version")) {
  process.stdout.write((scenario.version ?? "0.85.1") + "\\n");
  process.exit(0);
}

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const sessionFile = args[sessionIndex + 1];
const header = JSON.parse((await readFile(sessionFile, "utf8")).split("\\n", 1)[0]);
const messagePath = sessionFile + ".emulator-messages.json";
let persistedMessages = JSON.parse(await readFile(messagePath, "utf8").catch(() => "[]"));
const metadata = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];
await log({ type: "start", args, metadata: Object.fromEntries(metadata.map((name) => [name, process.env[name]])) });
if (scenario.spawnChild) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  descendant.unref();
  await log({ type: "descendant", pid: descendant.pid });
}

const endpoint = process.env.RAKAZO_LOCAL_PI_BRIDGE_ENDPOINT;
const bridge = async (action, body = {}) => {
  const response = await fetch(endpoint + "/" + action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "bridge rejected");
  return value;
};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const response = (command, success = true, data, error) =>
  send({ type: "response", command: command.type, success, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}), ...(command.id ? { id: command.id } : {}) });
let pendingUiCommand;
let startupUiResolve;
let aborted = false;
const decoder = new TextDecoder("utf-8", { fatal: true });
let buffered = "";
process.stdin.on("data", (chunk) => {
  try {
    buffered += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffered.indexOf("\\n");
      if (newline < 0) break;
      let line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.endsWith("\\r")) line = line.slice(0, -1);
      if (line) void handle(JSON.parse(line));
    }
  } catch (error) {
    void log({ type: "parse_error", error: String(error) });
    process.exit(8);
  }
});
const bootstrap = await bridge("bootstrap");
if (scenario.startupUiMethod) {
  send({ type: "extension_ui_request", id: "startup-ui", method: scenario.startupUiMethod, title: "Startup dialog" });
  await new Promise((resolve) => { startupUiResolve = resolve; });
}
await bridge("ready");

async function finishPrompt(command) {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  if (scenario.tool) {
    const configured = bootstrap.tools.find((tool) => tool.name === scenario.tool.name);
    if (!configured) {
      const lease = await bridge("lease", { effects: true });
      if (!lease.active) return;
    }
    const exposedName = configured?.exposedName ?? scenario.tool.name;
    const toolCallId = scenario.tool.callId ?? "tool-call-1";
    send({ type: "tool_execution_start", toolCallId, toolName: exposedName, args: scenario.tool.args ?? {} });
    let result;
    let isError = false;
    if (configured) {
      try {
        result = await bridge("tool", { handle: configured.handle, toolCallId, args: scenario.tool.args ?? {} });
      } catch (error) {
        isError = true;
        result = { content: [{ type: "text", text: String(error) }], details: {} };
      }
    } else {
      result = scenario.tool.result ?? {
        content: [{ type: "text", text: "native output" }],
        details: scenario.tool.details ?? {},
      };
    }
    send({ type: "tool_execution_update", toolCallId, toolName: exposedName, args: scenario.tool.args ?? {}, partialResult: result });
    send({ type: "tool_execution_end", toolCallId, toolName: exposedName, result, isError });
  }
  if (scenario.fabricComplete) {
    send({
      type: "message_end",
      message: {
        role: "custom",
        customType: "pi-fabric-agent-complete",
        content: "Helper finished",
        details: scenario.fabricComplete,
      },
    });
  }
  for (const delta of scenario.textChunks ?? ["Offline answer."]) {
    send({
      type: "message_update",
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });
  }
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: (scenario.textChunks ?? ["Offline answer."]).join("") }],
      provider: scenario.provider ?? "offline",
      model: scenario.model ?? "offline-model",
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: scenario.stopReason ?? "stop",
      ...(scenario.errorMessage ? { errorMessage: scenario.errorMessage } : {}),
      timestamp: Date.now(),
    },
  });
  send({ type: "turn_end", message: {}, toolResults: [] });
  send({ type: "agent_end", messages: [], willRetry: false });
  send({ type: "agent_settled" });
}

async function handle(command) {
  await log({ type: "command", command });
  if (command.type === "get_messages") {
    response(command, true, { messages: persistedMessages });
    return;
  }
  if (command.type === "get_state") {
    response(command, true, {
      model: { provider: "offline", id: "offline-model" },
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      sessionFile,
      sessionId: header.id,
      messageCount: 0,
      pendingMessageCount: 0,
    });
    return;
  }
  if (command.type === "set_model" || command.type === "set_thinking_level") {
    response(command, true, command.type === "set_model" ? { provider: command.provider, id: command.modelId } : undefined);
    return;
  }
  if (command.type === "compact") {
    send({ type: "compaction_start", reason: "manual" });
    send(scenario.compactionError
      ? { type: "compaction_end", reason: "manual", error: scenario.compactionError }
      : { type: "compaction_end", reason: "manual", result: { summary: "compact" } });
    response(command, true, scenario.compactionError ? { error: scenario.compactionError } : { summary: "compact" });
    return;
  }
  if (command.type === "extension_ui_response") {
    await log({ type: "ui_response", command });
    if (command.id === "startup-ui" && startupUiResolve) {
      startupUiResolve();
      startupUiResolve = undefined;
      return;
    }
    if (pendingUiCommand) {
      const pending = pendingUiCommand;
      pendingUiCommand = undefined;
      await finishPrompt(pending);
    }
    return;
  }
  if (command.type === "abort") {
    aborted = true;
    response(command, true);
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled" });
    return;
  }
  if (command.type !== "prompt") {
    response(command, false, undefined, "unsupported");
    return;
  }
  if (scenario.rejectPrompt) {
    response(command, false, undefined, "prompt rejected");
    return;
  }
  persistedMessages.push({ role: "user", content: command.message });
  await writeFile(messagePath, JSON.stringify(persistedMessages));
  response(command, true);
  const lease = await bridge("lease", { effects: false });
  if (!lease.active) return;
  if (scenario.exitOnPrompt) process.exit(7);
  if (scenario.waitForAbort) return;
  if (scenario.uiMethod) {
    pendingUiCommand = command;
    send({ type: "extension_ui_request", id: "ui-1", method: scenario.uiMethod, title: "Blocked dialog" });
    return;
  }
  await finishPrompt(command);
}

process.stdin.on("end", async () => {
  await log({ type: "end", aborted });
  process.exit(0);
});
`;

export async function writeLocalPiEmulator(cwd: string): Promise<string> {
  const command = join(cwd, "pi-local-emulator.mjs");
  await writeFile(command, emulatorSource, { mode: 0o700 });
  await chmod(command, 0o700);
  return command;
}

export async function writeLocalPiScenario(
  cwd: string,
  scenario: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(cwd, "pi-local-scenario.json"), JSON.stringify(scenario));
}

export async function readLocalPiEmulatorLog(cwd: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(join(cwd, "pi-local-emulator.jsonl"), "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
