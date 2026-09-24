import type { OfficeReplicaWork } from "@rakazo/contracts";

export interface ReplicaSink {
  event(type: string, payload: Record<string, unknown>): Promise<void>;
  heartbeat(): Promise<void>;
}

export interface ReplicaDriver {
  run(
    work: OfficeReplicaWork,
    sink: ReplicaSink,
    signal: AbortSignal,
  ): Promise<"completed" | "failed" | "cancelled">;
}

/**
 * Office-owned coding loop: model + computer exec/files on this machine.
 * Queue, HITL, and other control-plane tools stay unavailable until resume import.
 */
export function createOfficeReplicaDriver(options: {
  supervisor: { baseUrl: string; token: string; fetch?: typeof fetch };
  complete?: (
    work: OfficeReplicaWork,
    sink: ReplicaSink,
    signal: AbortSignal,
  ) => Promise<"completed" | "failed" | "cancelled">;
}): ReplicaDriver {
  const http = options.supervisor.fetch ?? fetch;
  const base = options.supervisor.baseUrl.replace(/\/$/, "");
  return {
    async run(work, sink, signal) {
      if (options.complete) return options.complete(work, sink, signal);
      await sink.heartbeat();
      await sink.event("runtime.activity", {
        phase: "office_owned",
        runId: work.runId,
        computerId: work.computerId,
      });
      const headers = {
        authorization: `Bearer ${options.supervisor.token}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": work.botId,
        "x-rakazo-space-id": work.spaceId,
        "x-rakazo-run-id": work.runId,
      };
      const health = await http(`${base}/health`, { signal, redirect: "error" });
      if (!health.ok) throw new Error("Office supervisor is unavailable");
      const reply = await completeWithModel(work, {
        http,
        base,
        headers,
        sink,
        signal,
      });
      await sink.event("thread.message.created", {
        role: "bot",
        text: reply,
      });
      await sink.event("run.completed", { runId: work.runId });
      return "completed";
    },
  };
}

async function completeWithModel(
  work: OfficeReplicaWork,
  ctx: {
    http: typeof fetch;
    base: string;
    headers: Record<string, string>;
    sink: ReplicaSink;
    signal: AbortSignal;
  },
): Promise<string> {
  const key = work.model.apiKey?.trim();
  const origin = work.model.baseUrl?.replace(/\/$/, "");
  if (!key || !origin) {
    return "Office owned this run but has no model credentials. It will resume when the control plane is back.";
  }
  const tools = [
    {
      type: "function",
      function: {
        name: "shell",
        description: "Run argv on the office computer.",
        parameters: {
          type: "object",
          properties: {
            argv: { type: "array", items: { type: "string" } },
            cwd: { type: "string" },
          },
          required: ["argv"],
        },
      },
    },
  ];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: work.instructions },
    ...work.history,
    { role: "user", content: work.prompt },
  ];
  for (let step = 0; step < 16; step++) {
    ctx.signal.throwIfAborted();
    await ctx.sink.heartbeat();
    const response = await ctx.http(`${origin}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: work.model.id,
        messages,
        tools,
      }),
      signal: ctx.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Office model request failed (${response.status})`);
    const body = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error("Office model returned no message");
    const calls = message.tool_calls ?? [];
    if (!calls.length) return (message.content ?? "").trim() || "Done.";
    messages.push(message);
    for (const call of calls) {
      if (call.function.name !== "shell") {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "Unavailable while the office owns this run.",
        });
        continue;
      }
      let argv: string[] = [];
      let cwd: string | undefined;
      try {
        const args = JSON.parse(call.function.arguments) as { argv?: string[]; cwd?: string };
        argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
        cwd = args.cwd;
      } catch {
        argv = [];
      }
      await ctx.sink.event("agent.tool.called", { name: "shell", argv, cwd });
      const exec = await ctx.http(`${ctx.base}/computers/${work.computerId}/exec`, {
        method: "POST",
        headers: ctx.headers,
        body: JSON.stringify({ argv, ...(cwd ? { cwd } : {}) }),
        signal: ctx.signal,
        redirect: "error",
      });
      const result = await exec.text();
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 32_000) });
    }
  }
  return "Stopped after the office step budget.";
}
