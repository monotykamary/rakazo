import { expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { createRpcHarness } from "./pi-rpc-test-emulator.js";

it("checkpoints native admission approval before product events without launching a child", async () => {
  const harness = await createRpcHarness({
    tool: {
      name: "fabric_exec",
      args: { code: 'return await agents.run({task:"Approval task"});' },
    },
  });
  const executeTool = vi.fn(async () => approvalPausedToolResult());
  const saved: Array<Record<string, any>> = [];
  let paused = false;
  try {
    for await (const event of harness.runtime.run(
      {
        ...harness.request,
        tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
        executeTool,
        session: {
          save: async (state) => {
            saved.push(structuredClone(state) as Record<string, any>);
          },
        },
      },
      { spaceId: "space", signal: AbortSignal.timeout(20000) },
    )) {
      if (
        event.type === "execution" &&
        event.name === "run_subagent" &&
        event.status === "paused"
      ) {
        paused = true;
        expect(
          saved.some((state) =>
            state.runtimeExecutionEvidence?.some(
              (evidence: any) =>
                evidence.executionId === event.executionId && evidence.status === "paused",
            ),
          ),
        ).toBe(true);
      }
    }
    expect(paused).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)!.agents).toMatchObject({ starts: 0, records: [] });
    expect(saved.at(-1)!.runtimeExecutionEvidence).toContainEqual(
      expect.objectContaining({ name: "run_subagent", status: "paused" }),
    );
    expect(harness.host.starts).toBe(1);
    expect(harness.host.reaped).toBe(1);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.tools.map((tool: any) => tool.function.name)).toEqual([
      "fabric_exec",
    ]);
  } finally {
    await harness.close();
  }
}, 30000);
