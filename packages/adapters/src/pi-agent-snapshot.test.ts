import { AgentService } from "pi-fabric/agents";
import { expect, it, vi } from "vitest";
import { restoreAgentSnapshot, workerSessionCheckpoint } from "./pi-agent-snapshot.js";

it("migrates legacy snapshots once and lets Fabric rebase only direct-root lineage", async () => {
  const session = {
    modelSelection: { effective: { modelId: "selected" } },
    modelRouting: { marker: "routing" },
    entries: [{ thinking: "private" }],
  };
  const old = {
    rootParticipantId: "old-root",
    participants: {
      child: {
        participantId: "child",
        parentParticipantId: "old-root",
        status: "completed",
        placement: { cwd: "project", worktreeId: "worktree" },
        session,
      },
      nested: {
        participantId: "nested",
        parentParticipantId: "child",
        status: "running",
        session: { marker: "nested" },
      },
    },
  };
  const execute = vi.fn(async () => ({ status: "completed" as const }));
  const service = new AgentService({
    rootId: "new-root",
    restorePolicy: "new-root",
    snapshot: restoreAgentSnapshot(old, "new-root"),
    port: { execute },
  });
  expect(execute).not.toHaveBeenCalled();
  expect(service.snapshot()).toMatchObject({
    rootId: "new-root",
    starts: 0,
    records: [
      {
        record: {
          id: "child",
          parentId: "new-root",
          generation: 1,
          checkpoint: { session, placement: { worktreeId: "worktree" } },
        },
      },
      { record: { id: "nested", parentId: "child", generation: 1, status: "paused" } },
    ],
  });
  expect(await service.status("new-root", "child")).not.toHaveProperty("checkpoint");
  const saved = service.snapshot();
  expect(
    restoreAgentSnapshot({ agents: saved, participants: { invalid: null } }, "later-root"),
  ).toEqual(saved);
  await service.close();
  expect(service.snapshot().records[1]!.record.status).toBe("paused");
});

it("keeps host memory, model routing and all other participants out of worker initialization", () => {
  const own = {
    entries: [{ marker: "own transcript" }],
    kitState: { managed: { memory: "own kernel memory" } },
  };
  expect(
    workerSessionCheckpoint({
      ...own,
      memory: { source: "host memory" },
      modelRouting: { marker: "host model routing" },
      agents: { records: [{ checkpoint: "other transcript" }] },
      participants: { child: "legacy" },
    }),
  ).toEqual(own);
});

it("rejects invalid legacy identity and lineage instead of falling back to a legacy runtime", () => {
  expect(() =>
    restoreAgentSnapshot(
      {
        rootParticipantId: "root",
        participants: {
          child: { participantId: "other", parentParticipantId: "root", status: "completed" },
        },
      },
      "next",
    ),
  ).toThrow("identity");
  expect(() =>
    restoreAgentSnapshot(
      {
        rootParticipantId: "root",
        participants: {
          child: { participantId: "child", parentParticipantId: "child", status: "completed" },
        },
      },
      "next",
    ),
  ).toThrow("lineage");
});
