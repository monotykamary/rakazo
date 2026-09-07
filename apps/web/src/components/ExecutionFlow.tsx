import { t } from "@lingui/core/macro";
import type {
  ExecutionFlowEdge,
  ExecutionFlowNode,
  ExecutionFlow as Flow,
} from "@rakazo/contracts";
import { executionFlowRows } from "@rakazo/core";
import { Button, Card } from "@rakazo/ui-web";
import {
  Bot,
  ChevronRight,
  Code2,
  CornerDownRight,
  Hourglass,
  MessageSquare,
  RotateCcw,
} from "lucide-react";
import { useId, useState } from "react";

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
  onRun,
  onEvidence,
}: {
  flow: Flow;
  rootRunId?: string;
  runIds?: string[];
  onRun: (runId: string) => void;
  onEvidence: (ids: string[]) => void;
}) {
  const runTitle = (id: string | undefined, ordinal: number) => {
    const index = runIds.indexOf(id ?? "");
    return index >= 0 ? t`Run ${index + 1}` : t`Related run ${ordinal}`;
  };
  const detailsId = useId();
  const [selectedId, setSelectedId] = useState<string>();
  const [edgeId, setEdgeId] = useState<string>();
  const rows = executionFlowRows(flow, rootRunId);
  const ordinals = new Map<ExecutionFlowNode["kind"], number>();
  const names = new Map(
    rows.map(({ node, relationships }) => {
      const ordinal = (ordinals.get(node.kind) ?? 0) + 1;
      ordinals.set(node.kind, ordinal);
      return [node.id, nodeTitle(node, ordinal, relationships)] as const;
    }),
  );
  return (
    <div className="min-w-0 space-y-3" data-testid="execution-flow">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t`No retained relationships`}</p>
      ) : (
        <Card className="gap-0 p-2">
          <ol aria-label={t`Flow`} className="min-w-0 space-y-1">
            {rows.map(({ node, depth, parent, relationships, runs }, index) => {
              const expanded = selectedId === node.id;
              const edge = expanded ? relationships.find((item) => item.id === edgeId) : undefined;
              const evidence = edge?.evidence ?? node.evidence;
              const eventIds = evidence
                .filter((item) => item.kind === "event")
                .map((item) => item.id);
              const Icon = nodeIcons[node.kind];
              const focusedRun = runs.find((run) => run.runId === rootRunId);
              const focusedStatus = focusedRun?.status ?? node.status;
              const code =
                node.code ?? focusedRun?.code ?? (runs.length === 1 ? runs[0]?.code : undefined);
              const status =
                statusLabel(focusedStatus) ??
                (runs.length > 1 ? t`${runs.length} runs` : undefined);
              const failed = focusedStatus === "failed" || focusedStatus === "run.failed";
              const id = `${detailsId}-${index}`;
              return (
                <li
                  key={node.id}
                  className="min-w-0"
                  style={{ paddingInlineStart: Math.min(depth, 3) * 16 }}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    {parent && (
                      <CornerDownRight
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <Button
                      variant="ghost"
                      data-flow-node={node.id}
                      aria-expanded={expanded}
                      aria-controls={expanded ? id : undefined}
                      onClick={() => {
                        setSelectedId(expanded ? undefined : node.id);
                        setEdgeId(undefined);
                      }}
                      className="h-auto min-h-12 min-w-0 flex-1 justify-start gap-3 whitespace-normal p-2 text-start aria-expanded:bg-muted"
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        {parent && (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {relationLabel(parent.kind)}
                          </span>
                        )}
                        <span className="line-clamp-2 break-words text-sm">
                          {names.get(node.id)}
                        </span>
                      </span>
                      {status && (
                        <span
                          className={`shrink-0 text-xs font-normal ${failed ? "text-destructive" : "text-muted-foreground"}`}
                        >
                          {status}
                        </span>
                      )}
                      <ChevronRight
                        aria-hidden="true"
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
                      />
                    </Button>
                  </div>
                  {expanded && (
                    <section
                      id={id}
                      aria-label={t`Evidence`}
                      className="my-2 min-w-0 space-y-3 border-s border-border ps-4 pe-2 text-sm"
                    >
                      {relationships.length > 0 && (
                        <ul aria-label={t`Relationships`} className="space-y-1">
                          {relationships.map((item) => (
                            <li key={item.id}>
                              <Button
                                data-flow-edge={item.id}
                                variant="ghost"
                                size="sm"
                                aria-pressed={edgeId === item.id}
                                className="h-auto max-w-full justify-start whitespace-normal text-start aria-pressed:bg-muted"
                                onClick={() => setEdgeId(edgeId === item.id ? undefined : item.id)}
                              >
                                {relationLabel(item.kind)} {names.get(item.to)}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!edge && code && (
                        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
                          {code}
                        </pre>
                      )}
                      <details key={edge?.id ?? node.id}>
                        <summary className="cursor-pointer py-2 text-xs text-muted-foreground">{t`Evidence`}</summary>
                        <ul className="space-y-1 text-xs text-muted-foreground">
                          {evidence.map((item) => (
                            <li className="break-all" key={`${item.kind}:${item.id}`}>
                              <span>{item.kind} · </span>
                              <code>{item.id}</code>
                            </li>
                          ))}
                        </ul>
                      </details>
                      <div className="flex flex-wrap items-center gap-2">
                        {!edge &&
                          runs.length > 1 &&
                          runs.map((run, runIndex) => (
                            <Button
                              key={run.id}
                              size="sm"
                              variant="outline"
                              disabled={!run.runId}
                              aria-pressed={run.runId === rootRunId}
                              onClick={() => {
                                if (run.runId) onRun(run.runId);
                              }}
                            >
                              {runTitle(run.runId, runIndex + 1)}
                            </Button>
                          ))}
                        {!edge && node.runId && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              if (node.runId) onRun(node.runId);
                            }}
                          >{t`Inspect run`}</Button>
                        )}
                        {eventIds.length > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onEvidence(eventIds)}
                          >{t`Show events`}</Button>
                        )}
                      </div>
                    </section>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
      )}
      {flow.hasMoreRelatedRuns && (
        <p className="text-sm text-muted-foreground">{t`More related runs are available. Open a run to inspect it.`}</p>
      )}
    </div>
  );
}
