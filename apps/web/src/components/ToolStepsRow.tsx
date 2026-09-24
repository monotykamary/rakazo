import { useLingui } from "@lingui/react/macro";
import { summarizeToolSteps } from "@rakazo/core";
import { BotAvatar, cn } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

export function ToolStepsRow({
  steps,
  color,
  identity,
}: {
  steps: readonly { label: string; count: number }[];
  color: string;
  identity: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const summary = summarizeToolSteps(steps) ?? {
    title: steps[0]?.label || t`Work`,
    count: Math.max(
      1,
      steps.reduce((sum, step) => sum + step.count, 0),
    ),
    latest: steps.at(-1)?.label || steps[0]?.label || t`Work`,
  };
  const countLabel = summary.count === 1 ? t`1 step` : t`${summary.count} steps`;

  return (
    <div data-testid="tool-steps" className="w-full max-w-xl">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 py-1 text-start text-[13.5px] text-muted-foreground hover:text-foreground"
      >
        <BotAvatar color={color} identity={identity} size={16} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{summary.title}</span>
          <span>
            {" "}
            · {countLabel} · {summary.latest}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          size={14}
          strokeWidth={1.8}
          className={cn("shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <ol className="ms-6 space-y-1.5 border-s border-border py-1 ps-3 text-[13px] text-muted-foreground">
          {steps.map((step, index) => (
            <li key={`${step.label}:${index}`} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 wrap-anywhere text-foreground/80">{step.label}</span>
              {step.count > 1 ? <span>×{step.count}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
