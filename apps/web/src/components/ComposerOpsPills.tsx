import { t } from "@lingui/core/macro";
import type { ComposerOps } from "@rakazo/core";
import { composerOpsVisible } from "@rakazo/core";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@rakazo/ui-web";
import { GitGraph } from "lucide-react";
import type { ReactNode } from "react";

export function ComposerOpsPills({
  ops,
  onInspectRun,
  onOpenRoutine,
}: {
  ops: ComposerOps;
  onInspectRun?: (runId: string, botId?: string) => void;
  onOpenRoutine?: (routineId: string) => void;
}) {
  if (!composerOpsVisible(ops)) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2" data-testid="composer-ops">
      {ops.working.length ? (
        <OpsPill
          testId="composer-ops-working"
          label={t`Working`}
          count={ops.working.length}
          icon={<GitGraph aria-hidden className="size-3" />}
        >
          {ops.working.map((run) => (
            <button
              key={run.id}
              type="button"
              className="flex w-full rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent"
              onClick={() => onInspectRun?.(run.id, run.botId)}
            >
              {run.name}
            </button>
          ))}
        </OpsPill>
      ) : null}
      {ops.pullRequests.length ? (
        <OpsPill testId="composer-ops-prs" label={t`PRs`} count={ops.pullRequests.length}>
          {ops.pullRequests.map((pullRequest) => (
            <a
              key={pullRequest.id}
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className="flex w-full rounded-md px-2 py-1.5 text-start text-sm no-underline hover:bg-accent"
            >
              {pullRequest.title}
            </a>
          ))}
        </OpsPill>
      ) : null}
      {ops.listening.length ? (
        <OpsPill
          testId="composer-ops-listening"
          label={t`Listening`}
          count={ops.listening.length}
        >
          {ops.listening.map((routine) => (
            <button
              key={routine.id}
              type="button"
              className="flex w-full rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent"
              onClick={() => onOpenRoutine?.(routine.id)}
            >
              {routine.name}
            </button>
          ))}
        </OpsPill>
      ) : null}
    </div>
  );
}

function OpsPill({
  label,
  count,
  icon,
  testId,
  children,
}: {
  label: string;
  count: number;
  icon?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        data-testid={testId}
        aria-label={`${label}, ${count}`}
        className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs text-muted-foreground hover:bg-accent"
        render={<button type="button" />}
      >
        {icon}
        {label} {count}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 gap-0.5 p-1.5">
        <PopoverTitle className="sr-only">{label}</PopoverTitle>
        {children}
      </PopoverContent>
    </Popover>
  );
}
