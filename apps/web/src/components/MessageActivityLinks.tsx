import { t } from "@lingui/core/macro";
import type { MessageActivity } from "@rakazo/core";
import { BotAvatar } from "@rakazo/ui-web";
import { Activity, Clock } from "lucide-react";
import { useState } from "react";

export function MessageExecutionButton({
  runId,
  botId,
  onExecution,
  className,
}: {
  runId: string;
  botId?: string;
  onExecution: (runId: string, botId?: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={t`Execution`}
      onClick={() => onExecution(runId, botId)}
      className={className}
    >
      <Activity size={15} strokeWidth={1.7} aria-hidden="true" />
    </button>
  );
}

export function lastMessageExecution(activities: readonly MessageActivity[]) {
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.kind === "execution") return activity;
  }
}

export function MessageActivityLinks({
  activities,
  peerBot,
  onPeer,
  onRoutine,
}: {
  activities: readonly MessageActivity[];
  peerBot: (botId: string) => { color: string } | undefined;
  onPeer: (peer: { botId?: string; peerBotId: string; peerBotName: string }) => void;
  onRoutine: (routineId: string, botId?: string) => void | Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const links = activities.filter((activity) => activity.kind !== "execution");
  if (!links.length) return null;
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="message-activity"
    >
      {links.map((activity) =>
        activity.kind === "peer" ? (
          <button
            key={`peer:${activity.botId}:${activity.peerBotId}`}
            type="button"
            data-testid="peer-receipt-chip"
            aria-label={
              activity.count === 1
                ? t`1 message with ${activity.peerBotName}`
                : t`${activity.count} messages with ${activity.peerBotName}`
            }
            onClick={() => onPeer(activity)}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 py-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span>
              {activity.count === 1 ? t`1 message with` : t`${activity.count} messages with`}
            </span>
            <BotAvatar
              color={peerBot(activity.peerBotId)?.color ?? "currentColor"}
              identity={activity.peerBotId}
              size={16}
            />
            <span className="truncate" dir="auto">
              {activity.peerBotName}
            </span>
          </button>
        ) : activity.kind === "routine" ? (
          <button
            key={`routine:${activity.action}:${activity.routineId}`}
            type="button"
            onClick={() => {
              setError(undefined);
              void Promise.resolve()
                .then(() => onRoutine(activity.routineId, activity.botId))
                .catch((cause) =>
                  setError(cause instanceof Error ? cause.message : t`Could not load routine`),
                );
            }}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 py-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span>{activity.action === "updated" ? t`Updated routine` : t`Created routine`}</span>
            <Clock size={14} aria-hidden="true" />
            <span className="truncate" dir="auto">
              {activity.name}
            </span>
          </button>
        ) : null,
      )}
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
