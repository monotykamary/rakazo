import { cn } from "@rakazo/ui-web";
import type { ReactNode } from "react";

export type HitlStatusTone = "need" | "ready" | "done";

export function HitlStatus({
  tone,
  children,
}: {
  tone: HitlStatusTone;
  children: ReactNode;
}) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-[11px] py-1 text-[13px]",
        tone === "need" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", tone === "need" ? "bg-warning" : "bg-muted-foreground/70")}
      />
      {children}
    </span>
  );
}
