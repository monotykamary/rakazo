import { t } from "@lingui/core/macro";
import type {
  ExecutionFlowEdge,
  ExecutionFlowNode,
  ExecutionFlow as Flow,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useId, useState } from "react";

export function ExecutionFlow({
  flow,
  onRun,
  onEvidence,
}: {
  flow: Flow;
  onRun: (runId: string) => void;
  onEvidence: (ids: string[]) => void;
}) {
  const markerId = useId();
  const [selected, setSelected] = useState<ExecutionFlowNode | ExecutionFlowEdge>();
  const nodes = flow.nodes.filter((node) => node.evidence.length > 0);
  const positions = new Map(
    nodes.map((node, index) => [
      node.id,
      { x: 20 + (index % 2) * 310, y: 20 + Math.floor(index / 2) * 170 },
    ]),
  );
  const edges = flow.edges.filter(
    (edge) => edge.evidence.length > 0 && positions.has(edge.from) && positions.has(edge.to),
  );
  const height = Math.max(150, Math.ceil(nodes.length / 2) * 170);
  const nodeName = (id: string) => nodes.find((node) => node.id === id)?.name ?? id;
  return (
    <div className="min-w-0 space-y-3">
      {nodes.length === 0 && (
        <p className="text-muted-foreground">{t`No retained relationships`}</p>
      )}
      {nodes.length > 0 && (
        <fieldset
          className="min-w-0 overflow-auto rounded border border-border"
          aria-label={t`Flow`}
        >
          <div className="relative" style={{ width: 610, height }}>
            <svg
              aria-hidden="true"
              className="absolute inset-0 text-muted-foreground"
              width="610"
              height={height}
            >
              <defs>
                <marker
                  id={markerId}
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8" fill="currentColor" />
                </marker>
              </defs>
              {edges.map((edge, index) => {
                const from = positions.get(edge.from)!;
                const to = positions.get(edge.to)!;
                // Route through gutters, never through an unrelated node card.
                const sameColumn = from.x === to.x;
                const leftColumn = from.x === 20;
                const x1 = sameColumn
                  ? from.x + (leftColumn ? 0 : 240)
                  : from.x + (from.x < to.x ? 240 : 0);
                const x2 = sameColumn
                  ? to.x + (leftColumn ? 0 : 240)
                  : to.x + (from.x < to.x ? 0 : 240);
                const y1 = from.y + (edge.from === edge.to ? 30 : 45);
                const y2 = to.y + (edge.from === edge.to ? 60 : 45);
                const channel = sameColumn ? (leftColumn ? 8 : 588) : 280 + (index % 5) * 6;
                return (
                  <path
                    key={edge.id}
                    data-flow-edge={edge.id}
                    d={`M${x1},${y1} H${channel} V${y2} H${x2}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    markerEnd={`url(#${markerId})`}
                  />
                );
              })}
            </svg>
            {nodes.map((node) => {
              const point = positions.get(node.id)!;
              return (
                <button
                  key={node.id}
                  type="button"
                  data-flow-node={node.id}
                  aria-pressed={selected?.id === node.id}
                  onClick={() => setSelected(node)}
                  className="absolute flex flex-col gap-1 overflow-hidden rounded-lg border border-border bg-card p-3 text-start text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  style={{ left: point.x, top: point.y, width: 240, height: 90 }}
                >
                  <span className="text-xs text-muted-foreground">
                    {node.kind}
                    {node.status ? ` · ${node.status}` : ""}
                  </span>
                  <span className="line-clamp-2 break-words">{node.name ?? node.id}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      <ul aria-label={t`Relationships`} className="space-y-1">
        {edges.map((edge) => (
          <li key={edge.id}>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto max-w-full whitespace-normal text-start"
              aria-pressed={selected?.id === edge.id}
              onClick={() => setSelected(edge)}
            >
              {nodeName(edge.from)} → {edge.kind} → {nodeName(edge.to)}
            </Button>
          </li>
        ))}
      </ul>
      {selected && (
        <section className="space-y-2 rounded border border-border p-3" aria-label={t`Evidence`}>
          <p className="break-words text-sm">
            {"name" in selected ? (selected.name ?? selected.id) : selected.kind}
          </p>
          {"code" in selected && selected.code && (
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
              {selected.code}
            </pre>
          )}
          {"runId" in selected && selected.runId && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRun(selected.runId!)}
            >{t`Inspect run`}</Button>
          )}
          <ul className="text-xs text-muted-foreground">
            {selected.evidence.map((item) => (
              <li className="break-words" key={`${item.kind}:${item.id}`}>
                {item.kind} · {item.id}
              </li>
            ))}
          </ul>
          {selected.evidence.some((item) => item.kind === "event") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onEvidence(
                  selected.evidence.filter((item) => item.kind === "event").map((item) => item.id),
                )
              }
            >{t`Show events`}</Button>
          )}
        </section>
      )}
      {flow.hasMoreRelatedRuns && (
        <p className="text-sm text-muted-foreground">{t`More related runs are available. Open a run to inspect it.`}</p>
      )}
    </div>
  );
}
