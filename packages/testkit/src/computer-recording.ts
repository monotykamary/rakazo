import assert from "node:assert/strict";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  BrowserProvider,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
  builtinAgentTools,
  observationToolResult,
} from "@rakazo/adapters";
import { waitForReplayFile } from "./computer-replay.js";
import {
  CONTACTS_CSV,
  CONTACTS_PATH,
  ContactsBrowserFixture,
  EXPORT_FIXTURE_URL,
  EXPORT_RECEIPT_PATH,
} from "./computer-replay-fixture.js";
import {
  type ModelEmulatorRequest,
  type ModelEmulatorResponse,
  type ModelEmulatorStep,
  startModelEmulator,
} from "./model-emulator.js";

const targets = ["Export contacts", "Download CSV", "Cancel"] as const;
type Target = (typeof targets)[number];
type Intent =
  | { op: "navigate" | "snapshot" | "observe" | "read" }
  | { op: "click"; target: Target };
export type ContactsRecordedStep = Intent & { outcome: "ok" | "error" };
export interface ContactsRecording {
  version: 1;
  scenario: "contacts-export";
  source: "authored" | "luna-openrouter-docker";
  steps: ContactsRecordedStep[];
}

/** Closed vocabulary: no model prose, raw responses, URLs, keys, IDs, refs, or images leave memory. */
export function parseContactsRecording(value: unknown): ContactsRecording {
  assert.ok(value && typeof value === "object");
  const record = value as ContactsRecording;
  assert.deepEqual(Object.keys(record).sort(), ["scenario", "source", "steps", "version"]);
  assert.equal(record.version, 1);
  assert.equal(record.scenario, "contacts-export");
  assert.ok(record.source === "authored" || record.source === "luna-openrouter-docker");
  assert.ok(Array.isArray(record.steps) && record.steps.length > 0 && record.steps.length <= 40);
  for (const step of record.steps) {
    assert.deepEqual(
      Object.keys(step).sort(),
      step.op === "click" ? ["op", "outcome", "target"] : ["op", "outcome"],
    );
    assert.ok(["navigate", "snapshot", "observe", "read", "click"].includes(step.op));
    assert.ok(step.outcome === "ok" || step.outcome === "error");
    if (step.op === "click") assert.ok(targets.includes(step.target));
  }
  return structuredClone(record);
}

export const contactsToolNames = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "computer_observe",
  "read_file",
]);

/** Narrow controlled-site recorder. Unsupported input is rejected before executing a tool. */
export function createContactsRecorder(
  sandbox: SandboxProvider,
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  const steps: ContactsRecordedStep[] = [];
  let elements: Array<{ name: string; ref: string }> = [];
  return {
    /** Safe even for an interrupted/empty attempt; never contains raw tool arguments or outputs. */
    decisions(): ContactsRecordedStep[] {
      return structuredClone(steps);
    },
    recording(source: ContactsRecording["source"]): ContactsRecording {
      return parseContactsRecording({ version: 1, scenario: "contacts-export", source, steps });
    },
    async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      context.signal.throwIfAborted();
      assert.ok(steps.length < 40, "Recording exceeds its tool budget");
      let intent: Intent;
      let result: unknown;
      if (name === "browser_navigate") {
        assert.deepEqual(
          args,
          { url: EXPORT_FIXTURE_URL },
          "Only the controlled fixture may be recorded",
        );
        intent = { op: "navigate" };
        result = await browserNavigateFromTool(browser, computer, context, args);
      } else if (name === "browser_act") {
        assert.deepEqual(Object.keys(args), ["actions"]);
        const actions = args.actions as Array<{ kind: string; ref: string }>;
        assert.ok(Array.isArray(actions) && actions.length === 1, "Record one click at a time");
        const action = actions[0]!;
        assert.deepEqual(Object.keys(action).sort(), ["kind", "ref"]);
        assert.equal(action.kind, "click");
        const target = elements.find((node) => node.ref === action.ref)?.name as Target;
        assert.ok(targets.includes(target), "Only known current fixture buttons may be recorded");
        intent = { op: "click", target };
        result = await browserActFromTool(browser, computer, context, args);
      } else if (name === "read_file") {
        assert.deepEqual(args, { path: CONTACTS_PATH }, "Only the synthetic CSV may be recorded");
        intent = { op: "read" };
        result = {
          path: CONTACTS_PATH,
          content: await waitForReplayFile(sandbox, computer, context, CONTACTS_PATH),
        };
      } else if (name === "browser_snapshot" || name === "computer_observe") {
        assert.deepEqual(args, {});
        intent = { op: name === "browser_snapshot" ? "snapshot" : "observe" };
        if (name === "browser_snapshot") {
          result = await browserSnapshotFromTool(browser, computer, context, args);
        } else {
          const observation = await sandbox.observe(computer, context);
          assert.equal(observation.mimeType, "image/png");
          assert.deepEqual([...observation.image.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
          result = observationToolResult(observation);
        }
      } else {
        throw new Error("Tool is outside the recording fixture's allowlist");
      }
      const object = result as Record<string, unknown>;
      if (Array.isArray(object.elements)) elements = object.elements;
      steps.push({ ...intent, outcome: object.error || object.ok === false ? "error" : "ok" });
      return result;
    },
  };
}

export async function executeContactsJourney(
  model: AgentRunRequest["model"],
  recorder: ReturnType<typeof createContactsRecorder>,
  context: AdapterContext,
  runtime: AgentRuntime,
) {
  for await (const _event of runtime.run(
    {
      botId: context.botId!,
      threadId: "fixture-thread",
      runId: context.operationId,
      prompt: `Export the two synthetic contacts at ${EXPORT_FIXTURE_URL} and verify ${CONTACTS_PATH}.`,
      instructions:
        "Use extensions.browser_navigate, inspect the page, and click the current refs one at a time. Only the local fixture is allowed. Call extensions.computer_observe once to check the screen. Use pi.read to verify the CSV. Do not write the CSV yourself. Recover from temporary download errors by inspecting current state before retrying. Finish once the CSV is verified.",
      history: [],
      model,
      tools: builtinAgentTools.filter((tool) => contactsToolNames.has(tool.name)),
      executeTool: recorder.executeTool,
    },
    context,
  )) {
    /* Prose and provider metadata are deliberately not recorded. */
  }
}

function toolResults(request: ModelEmulatorRequest) {
  return request.messages.filter((message) => message.role === "tool");
}

function resultObject(content: unknown): Record<string, unknown> | undefined {
  const text = typeof content === "string" ? content : "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Reproduce transient download failures before validating a captured journey offline. */
export function createContactsReplayBrowser(
  sandbox: SandboxProvider,
  recording: ContactsRecording,
) {
  const downloadFailures = parseContactsRecording(recording).steps.filter(
    (step) => step.op === "click" && step.target === "Download CSV" && step.outcome === "error",
  ).length;
  return new ContactsBrowserFixture(sandbox, { downloadFailures });
}

/** Replays decisions through real Pi/HTTP; production browser helpers still produce every effect. */
export async function replayContactsRecording(
  recording: ContactsRecording,
  sandbox: SandboxProvider,
  browser: BrowserProvider,
  computer: ComputerRef,
  context: AdapterContext,
  runtime: AgentRuntime,
) {
  const record = parseContactsRecording(recording);
  const recorder = createContactsRecorder(sandbox, browser, computer, context);
  const emulator = await startModelEmulator({ steps: contactsReplaySteps(record) });
  try {
    await executeContactsJourney(emulator.model, recorder, context, runtime);
    emulator.assertComplete();
    assert.deepEqual(recorder.recording(record.source), record);
  } finally {
    await emulator.close();
  }
}

/** The sealed worker uses native core tools and captured product capabilities inside Fabric. */
function fabricToolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ModelEmulatorResponse {
  return {
    type: "tool",
    id,
    name: "fabric_exec",
    arguments: {
      code:
        name === "read_file"
          ? `return {content: await pi.read(${JSON.stringify(args)})};`
          : `return await extensions.${name}(${JSON.stringify(args)});`,
      resultFormat: "json",
    },
  };
}

/** Recover the outermost JSON object embedded in free text, following error wrappers. */
function embeddedObject(value: string): Record<string, unknown> | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.message === "string") {
      const inner = embeddedObject(record.message);
      if (inner) return inner;
    }
    return record;
  } catch {
    return undefined;
  }
}

/** Fabric seals tool results in a JSON envelope; unwrap the recorded result value. */
function recordedResult(content: unknown): Record<string, unknown> | undefined {
  if (typeof content !== "string") return undefined;
  const envelope = resultObject(content);
  if (!envelope) return embeddedObject(content);
  if (typeof envelope.text === "string") {
    const inner = resultObject(envelope.text);
    if (inner) return inner;
  }
  return envelope;
}

export function contactsReplaySteps(record: ContactsRecording): ModelEmulatorStep[] {
  return [...record.steps, null].map((step, index) => ({
    expect(request) {
      assert.deepEqual(
        request.tools?.map((tool) => tool.function.name),
        ["fabric_exec"],
      );
      if (!index) return;
      const result = toolResults(request).at(-1);
      assert.equal(result?.tool_call_id, `recorded-${index - 1}`);
      const previous = record.steps[index - 1]!;
      if (previous.op === "observe") {
        assert.match(String(result?.content), /computer observed/);
      } else {
        const object = recordedResult(result?.content);
        assert.ok(object, "Expected a structured tool result");
        assert.equal(object.error || object.ok === false ? "error" : "ok", previous.outcome);
        if (previous.op === "read") assert.equal(object.content, CONTACTS_CSV);
      }
    },
    response(request) {
      if (!step) return { type: "text" as const, text: "Fixture replay complete." };
      switch (step.op) {
        case "navigate":
          return fabricToolCall(`recorded-${index}`, "browser_navigate", {
            url: EXPORT_FIXTURE_URL,
          });
        case "snapshot":
          return fabricToolCall(`recorded-${index}`, "browser_snapshot");
        case "observe":
          return fabricToolCall(`recorded-${index}`, "computer_observe");
        case "read":
          return fabricToolCall(`recorded-${index}`, "read_file", { path: CONTACTS_PATH });
        case "click": {
          const snapshot = toolResults(request)
            .map((result) => recordedResult(result.content))
            .findLast((result) => Array.isArray(result?.elements));
          const candidates = (
            snapshot?.elements as Array<{ name: string; ref: string }> | undefined
          )?.filter((node) => node.name === step.target);
          assert.equal(
            candidates?.length,
            1,
            "Recorded button must exist uniquely in the current snapshot",
          );
          return fabricToolCall(`recorded-${index}`, "browser_act", {
            actions: [{ kind: "click", ref: candidates![0]!.ref }],
          });
        }
      }
    },
  }));
}

export async function assertContactsExport(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  assert.equal(await waitForReplayFile(sandbox, computer, context, CONTACTS_PATH), CONTACTS_CSV);
  assert.equal(
    await waitForReplayFile(sandbox, computer, context, EXPORT_RECEIPT_PATH),
    "1",
    "The export must occur exactly once",
  );
}
