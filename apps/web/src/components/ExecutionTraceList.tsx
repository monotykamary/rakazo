import { t } from "@lingui/core/macro";
import type { ProductEvent } from "@rakazo/contracts";
import {
  type ExecutionTraceKind,
  executionTracePreview,
  groupExecutionTrace,
} from "@rakazo/core";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

export function executionTraceKindLabel(kind: ExecutionTraceKind, type?: ProductEvent["type"]) {
  switch (kind) {
    case "reasoning":
      return t`Reasoning`;
    case "tool":
      return t`Tool`;
    case "message":
      return t`Message`;
    case "run":
      return t`Run`;
    case "execution":
      return t`Call`;
    case "activity":
      return t`Activity`;
    default:
      return type?.split(".").pop()?.replace(/_/g, " ") ?? t`Event`;
  }
}

export function formatExecutionTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((now - date.getTime()) / 1000);
  if (seconds < 45) return t`just now`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t`${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t`${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return t`${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ExecutionTraceList({
  events,
  now,
}: {
  events: ProductEvent[];
  now?: number;
}) {
  const groups = groupExecutionTrace(events);
  const [openId, setOpenId] = useState<string>();
  return (
    <ol className="ms-1 border-s border-border" aria-label={t`Retained events`} data-testid="execution-trace">
      {groups.map((group) => {
        const event = group.events[group.events.length - 1]!;
        const expanded = openId === event.id;
        const preview = executionTracePreview(event.payload);
        return (
          <li key={event.id} className="min-w-0">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpenId(expanded ? undefined : event.id)}
              className="flex w-full min-w-0 items-center gap-2 py-1.5 ps-3 pe-1 text-start"
            >
              <span className="w-[4.75rem] shrink-0 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                {executionTraceKindLabel(group.kind, event.type)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/80">
                {preview ?? ""}
              </span>
              <time
                className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                dateTime={event.createdAt}
              >
                {formatExecutionTime(event.createdAt, now)}
              </time>
              <ChevronRight
                aria-hidden="true"
                className={`size-3 shrink-0 text-muted-foreground transition-transform ${
                  expanded ? "rotate-90" : ""
                }`}
              />
            </button>
            {expanded ? (
              <pre className="mb-2 ms-[5.5rem] overflow-auto whitespace-pre-wrap break-words pe-2 text-[11px] leading-5 text-muted-foreground">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
