import { t } from "@lingui/core/macro";
import type {
  ExecutionFlowEdge,
  ExecutionFlowNode,
  ExecutionFlow as Flow,
} from "@rakazo/contracts";
import { executionFlowRows } from "@rakazo/core";
import { SpringDisclosure } from "@rakazo/ui-web/components/ui/motion";
import {
  Bot,
  Code2,
  CornerDownRight,
  Hourglass,
  MessageSquare,
  RotateCcw,
} from "lucide-react";

function nodeTitle(node: ExecutionFlowNode, ordinal: number, relationships: ExecutionFlowEdge[]) {
  if (node.name) {
    if (node.kind === "execution" || node.kind === "recovery") {
      const name = node.name.replace(/[_.]+/g, " ");
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    if (node.kind !== "wait") return node.name;
  }
  switch (node.kind) {
    case "run":
      return t`Run ${ordinal}`;
    case "execution":
      return t`Execution ${ordinal}`;
    case "participant":
      return t`Participant ${ordinal}`;
    case "message":
      if (relationships.some((edge) => edge.kind === "results")) return t`Result`;
      if (relationships.some((edge) => edge.kind === "replies")) return t`Reply`;
      return t`Message ${ordinal}`;
    case "wait":
      return t`Waiting for input`;
    case "recovery":
      return t`Recovery`;
  }
}

function relationLabel(kind: ExecutionFlowEdge["kind"]) {
  switch (kind) {
    case "contains":
      return t`Includes`;
    case "calls":
      return t`Calls`;
    case "delegates":
      return t`Delegates to`;
    case "waits-for":
      return t`Waits for`;
    case "continues":
      return t`Continues`;
    case "starts":
      return t`Starts`;
    case "results":
      return t`Returns to`;
    case "messages":
      return t`Messages`;
    case "replies":
      return t`Replies to`;
  }
}

function statusLabel(status?: string) {
  switch (status?.replace(/^run\./, "")) {
    case "completed":
      return t`Completed`;
    case "failed":
      return t`Failed`;
    case "cancelled":
      return t`Cancelled`;
    case "stopped":
      return t`Stopped`;
    case "running":
    case "active":
    case "busy":
    case "streaming":
      return t`Running`;
    case "waiting":
    case "waiting_input":
      return t`Waiting`;
    case "pending":
    case "queued":
      return t`Pending`;
    default:
      return undefined;
  }
}

const nodeIcons = {
  run: Bot,
  participant: Bot,
  execution: Code2,
  message: MessageSquare,
  wait: Hourglass,
  recovery: RotateCcw,
};

export function ExecutionFlow({
  flow,
  rootRunId,
  runIds = [],
  selectedId,
  onSelect,
  onRun,
  onOpenAgent,
  onEvidence,
}: {
  flow: Flow;
  rootRunId?: string;
  runIds?: string[];
  selectedId?: string;
  onSelect?: (id: string | undefined) => void;
  onRun: (runId: string) => void;
  onOpenAgent?: (agent: { participantId: string; name?: string; status?: string }) => void;
  onEvidence: (ids: string[]) => void;
}) {
  const rows = executionFlowRows(flow, rootRunId);
  const ordinals = new Map<ExecutionFlowNode["kind"], number>();
  const names = new Map(
    rows.map(({ node, relationships }) => {
      const ordinal = (ordinals.get(node.kind) ?? 0) + 1;
      ordinals.set(node.kind, ordinal);
      return [node.id, nodeTitle(node, ordinal, relationships)] as const;
    }),
  );
  if (rows.length === 0) return null;
  return (
    <ol aria-label={t`Flow`} className="min-w-0 space-y-0.5" data-testid="execution-flow">
      {rows.map(({ node, depth, parent, runs }) => {
        const Icon = nodeIcons[node.kind];
        const selected = selectedId === node.id;
        const focusedRun = runs.find((run) => run.runId === rootRunId);
        const focusedStatus = focusedRun?.status ?? node.status;
        const status = statusLabel(focusedStatus);
        const failed = focusedStatus === "failed" || focusedStatus === "run.failed";
        const eventIds = node.evidence.filter((item) => item.kind === "event").map((item) => item.id);
        return (
          <li
            key={node.id}
            className="min-w-0"
            style={{ paddingInlineStart: Math.min(depth, 3) * 12 }}
          >
            <button
              type="button"
              data-flow-node={node.id}
              aria-pressed={selected}
              onClick={() => {
                onSelect?.(selected ? undefined : node.id);
                if (node.kind === "participant" && node.participantId) {
                  onOpenAgent?.({
                    participantId: node.participantId,
                    name: node.name,
                    status: node.status,
                  });
                  return;
                }
                if (node.runId && node.runId !== rootRunId) onRun(node.runId);
                else if (eventIds.length) onEvidence(eventIds);
              }}
              className={`flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-start transition-colors duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
                selected ? "bg-muted" : "hover:bg-muted/60"
              }`}
            >
              {parent && node.kind !== "participant" ? (
                <CornerDownRight
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
              ) : (
                <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                {parent ? (
                  <span className="block text-[11px] text-muted-foreground">
                    {relationLabel(parent.kind)}
                  </span>
                ) : null}
                <span className="block truncate text-[13px]">{names.get(node.id)}</span>
              </span>
              {status ? (
                <span
                  className={`shrink-0 text-[11px] ${
                    failed ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {status}
                </span>
              ) : null}
            </button>
            <SpringDisclosure open={selected && Boolean(node.code)}>
              <pre className="mb-1 ms-7 overflow-auto whitespace-pre-wrap break-words pe-2 text-[11px] leading-5 text-muted-foreground">
                {node.code}
              </pre>
            </SpringDisclosure>
          </li>
        );
      })}
    </ol>
  );
}
