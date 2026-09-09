import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildRakazoGuidance } from "./rakazo-guidance.js";

const endpoint = process.env.RAKAZO_LOCAL_PI_BRIDGE_ENDPOINT;
const modelProbe = process.env.RAKAZO_PI_MODEL_PROBE === "1";

type BootstrapTool = {
  handle: string;
  exposedName: string;
  name: string;
  description: string;
  parameters: unknown;
};

type Bootstrap = {
  instructions?: string;
  continuation?: string;
  tools: BootstrapTool[];
};

async function bridge<T>(action: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
  if (!endpoint) throw new Error("Rakazo local Pi bridge is unavailable");
  const timeout =
    action === "lease"
      ? AbortSignal.timeout(5_000)
      : action === "bootstrap" || action === "ready" || action === "collision"
        ? AbortSignal.timeout(15_000)
        : undefined;
  const requestSignal =
    signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
  const response = await fetch(`${endpoint}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: requestSignal,
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || "Rakazo local Pi bridge rejected the request");
  return value;
}

export default function localPiExtension(pi: ExtensionAPI) {
  if (modelProbe) return;
  let instructions = "";
  const productTools = new Set<string>();

  pi.on("session_start", async () => {
    const bootstrap = await bridge<Bootstrap>("bootstrap");
    instructions = [
      bootstrap.instructions?.trim(),
      bootstrap.continuation
        ? `Continue from this Rakazo checkpoint: ${bootstrap.continuation}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    const installed = new Set(pi.getAllTools().map((tool) => tool.name));
    for (const tool of bootstrap.tools) {
      if (installed.has(tool.exposedName)) {
        await bridge("collision", { name: tool.exposedName });
        throw new Error(
          `Rakazo product tool conflicts with installed Pi tool: ${tool.exposedName}`,
        );
      }
      productTools.add(tool.exposedName);
      installed.add(tool.exposedName);
      pi.registerTool({
        name: tool.exposedName,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters as never,
        async execute(toolCallId, params, signal) {
          return (await bridge(
            "tool",
            { handle: tool.handle, toolCallId, args: params },
            signal,
          )) as never;
        },
      });
    }
    await bridge("ready");
  });

  pi.on("before_agent_start", async (event) => {
    const lease = await bridge<{ active: boolean; pause?: boolean }>("lease", { effects: false });
    if (!lease.active) throw new Error("Rakazo run is paused");
    const guidance = buildRakazoGuidance({
      exposedToolNames: [...productTools],
      fabricAvailable: pi.getActiveTools().includes("fabric_exec"),
    });
    return {
      systemPrompt: [event.systemPrompt, instructions, guidance].filter(Boolean).join("\n\n"),
    };
  });

  pi.on("tool_call", async (event) => {
    if (productTools.has(event.toolName)) return;
    try {
      const lease = await bridge<{ active: boolean; pause?: boolean }>("lease", { effects: true });
      if (lease.active) return;
      return { block: true, reason: "Rakazo run is paused" };
    } catch {
      return { block: true, reason: "Rakazo run lease is no longer active" };
    }
  });
}
