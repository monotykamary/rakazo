import { t } from "@lingui/core/macro";
import type { QueueSnapshot } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { SpringDisclosure } from "@rakazo/ui-web/components/ui/motion";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CirclePause,
  CornerDownRight,
  FastForward,
  FileText,
  ListOrdered,
  Monitor,
  MoreHorizontal,
  Paperclip,
  Pause,
  Play,
  Target,
} from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { rpc } from "../lib/rpc";
import { queueRows, useQueue } from "../lib/use-queue";

const queueClient = rpc.queue;
type QueueRow = QueueSnapshot["rows"][number];

export type QueueStripHandle = {
  saveEdit: (text: string) => Promise<boolean>;
  cancelEdit: () => Promise<boolean>;
};

export const QueueStrip = forwardRef<
  QueueStripHandle,
  {
    threadId: string;
    botId: string;
    runIds?: string[];
    initialOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onEditChange?: (row: QueueRow | null) => void;
    onPopulatedChange?: (populated: boolean) => void;
    onOpenComputer?: () => void;
    targetControl?: ReactNode;
    participantId?: string;
    participantNames?: Readonly<Record<string, string>>;
  }
>(function QueueStrip(
  {
    threadId,
    botId,
    initialOpen,
    open: controlledOpen,
    onOpenChange,
    onEditChange,
    onPopulatedChange,
    onOpenComputer,
    targetControl,
    participantId,
    participantNames,
  },
  ref,
) {
  const { snapshot, error, busy, mutate } = useQueue(queueClient, threadId, botId);
  const [localOpen, setLocalOpen] = useState<boolean | undefined>(initialOpen);
  const [confirmResume, setConfirmResume] = useState(false);
  const rows = (snapshot ? queueRows(snapshot) : []).filter(
    (row) => !participantId || row.target?.participantId === participantId,
  );
  const selected = snapshot?.editing?.selectedId;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const disabled = busy || !snapshot;
  const locked = Boolean(snapshot?.inFlight || snapshot?.drain);
  const resuming = !snapshot?.drain && Boolean(snapshot?.paused || snapshot?.errorHold);
  const open = controlledOpen ?? localOpen ?? rows.length > 0;

  const visible = rows.length > 0 || Boolean(error) || Boolean(snapshot?.errorHold);
  useEffect(() => onPopulatedChange?.(visible), [onPopulatedChange, visible]);

  useImperativeHandle(
    ref,
    () => ({
      async saveEdit(text) {
        if (!selectedRef.current) return false;
        if (!(await mutate({ type: "edit-patch", patch: { text } }))) return false;
        const saved = await mutate({ type: "edit-save" });
        if (saved) onEditChange?.(null);
        return saved;
      },
      async cancelEdit() {
        if (!selectedRef.current) return false;
        const cancelled = await mutate({ type: "edit-cancel" });
        if (cancelled) onEditChange?.(null);
        return cancelled;
      },
    }),
    [mutate, onEditChange],
  );

  function setOpen(value: boolean) {
    setLocalOpen(value);
    onOpenChange?.(value);
  }

  async function beginEdit(row: QueueRow) {
    if (await mutate({ type: "edit-begin", id: row.id })) onEditChange?.(row);
  }

  if (rows.length === 0 && !error && !snapshot?.errorHold) return null;

  return (
    <section
      aria-label={t`Queue`}
      data-testid="composer-queue"
      className="relative z-0 -mb-px min-w-0 rounded-t-[18px] border border-border bg-muted/70 pb-1 pt-1 text-sm shadow-sm"
    >
      <div className="flex min-h-8 items-center ps-2 pe-1">
        <button
          type="button"
          aria-label={rows.length === 1 ? t`Queue, 1 message` : t`Queue, ${rows.length} messages`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-start text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ListOrdered aria-hidden className="size-3.5 shrink-0" />
          <span className="font-medium tabular-nums">{rows.length}</span>
          {snapshot?.errorHold ? (
            <CircleAlert aria-hidden className="size-3.5 text-destructive" />
          ) : null}
          {snapshot?.inFlight ? (
            <span className="truncate text-xs">{t`Delivery pending`}</span>
          ) : null}
          {snapshot?.compaction ? <span className="truncate text-xs">{t`Compacting`}</span> : null}
        </button>
        {targetControl}
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={open ? t`Hide queue` : t`Show queue`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="shrink-0 text-muted-foreground"
          >
            <ArrowDown
              aria-hidden
              className={`size-3.5 transition-transform duration-300 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t`Queue options`}
              render={
                <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground" />
              }
            >
              <MoreHorizontal aria-hidden className="size-3.5" />
            </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={
                disabled ||
                Boolean(selected) ||
                (resuming &&
                  (locked || Boolean(snapshot?.compaction || snapshot?.gracefulPausePending)))
              }
              onClick={() =>
                resuming && snapshot?.uncertainRowIds.length
                  ? setConfirmResume(true)
                  : void mutate({ type: resuming ? "resume" : "pause" })
              }
            >
              {resuming ? <Play /> : <Pause />}
              {resuming ? t`Resume` : t`Pause`}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={
                disabled ||
                Boolean(selected) ||
                locked ||
                !rows.length ||
                Boolean(
                  snapshot?.errorHold || snapshot?.compaction || snapshot?.gracefulPausePending,
                ) ||
                Boolean(rows[0]?.paused) ||
                !rows[0]?.placement ||
                rows[0]?.placement?.kind === "unbound" ||
                Boolean(snapshot?.uncertainRowIds.length)
              }
              onClick={() => void mutate({ type: "drain" })}
            >
              <FastForward />
              {t`Drain all`}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="queue-graceful-pause"
              disabled={
                disabled ||
                Boolean(snapshot?.gracefulPausePending) ||
                Boolean(snapshot?.compaction) ||
                Boolean(selected)
              }
              onClick={() => void mutate({ type: "graceful-pause" })}
            >
              <CirclePause />
              {snapshot?.gracefulPausePending ? t`Pause pending` : t`Pause`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-1.5 pb-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {snapshot?.errorHold ? (
        <p role="status" className="px-1.5 pb-1 text-xs text-muted-foreground">
          {t`Waiting for recovery`}
        </p>
      ) : null}
      <SpringDisclosure open={open}>
        <ol
          className="max-h-[min(15rem,35dvh)] overflow-y-auto overscroll-contain"
          aria-label={t`Execution order`}
        >
          {rows.map((row, index) => {
            const uncertain = snapshot?.uncertainRowIds.includes(row.id);
            const removed = "removed" in row && Boolean(row.removed);
            const rowDisabled = disabled || locked || Boolean(selected && selected !== row.id);
            return (
              <li
                key={row.id}
                data-row-id={row.id}
                data-lane={row.lane}
                className={`group/queue-row flex min-w-0 items-center rounded-lg ps-2 pe-1 ${
                  selected === row.id
                    ? "bg-accent ring-1 ring-inset ring-border"
                    : "hover:bg-accent/70"
                } ${removed ? "opacity-60" : ""}`}
              >
                <button
                  type="button"
                  disabled={rowDisabled || selected === row.id}
                  onClick={() => void beginEdit(row)}
                  aria-label={t`Edit queued message: ${row.text || "attachment"}`}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                >
                  <span
                    className="mt-0.5 text-muted-foreground"
                    title={row.lane === "steer" ? t`Steer` : t`Follow-up`}
                  >
                    {row.lane === "steer" ? (
                      <CornerDownRight aria-hidden className="size-3.5" />
                    ) : (
                      <ArrowDown aria-hidden className="size-3.5" />
                    )}
                    <span className="sr-only">
                      {row.lane === "steer" ? t`Steer` : t`Follow-up`}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      dir="auto"
                      className="line-clamp-2 break-words text-[13px] leading-[18px] text-foreground/85"
                    >
                      {row.text || t`Attachment`}
                    </span>
                    {row.images.length || row.attachments?.length ? (
                      <span className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
                        {row.images.slice(0, 3).map((image, imageIndex) => (
                          <img
                            key={`${row.id}-image-${imageIndex}`}
                            src={`data:${image.mimeType};base64,${image.data}`}
                            alt=""
                            aria-hidden="true"
                            className="size-5 shrink-0 rounded border border-border object-cover"
                          />
                        ))}
                        {row.attachments?.slice(0, 2).map((attachment) => (
                          <span
                            key={attachment.artifactId}
                            className="inline-flex min-w-0 max-w-32 items-center gap-1 rounded-full border border-border bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {attachment.mimeType.startsWith("image/") ? (
                              <FileText className="size-2.5 shrink-0" />
                            ) : (
                              <Paperclip className="size-2.5 shrink-0" />
                            )}
                            <span className="truncate">{attachment.name}</span>
                          </span>
                        ))}
                        {row.images.length + (row.attachments?.length ?? 0) > 5 ? (
                          <span className="text-[10px] text-muted-foreground">
                            +{row.images.length + (row.attachments?.length ?? 0) - 5}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 pt-0.5 text-muted-foreground">
                    {row.target ? (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Target
                          aria-label={
                            participantNames?.[row.target.participantId] ?? t`Participant targeted`
                          }
                          className="size-3"
                        />
                        {participantNames?.[row.target.participantId] ?? null}
                      </span>
                    ) : null}
                    {row.paused ? <Pause aria-label={t`Held`} className="size-3" /> : null}
                    {uncertain ? (
                      <CircleAlert
                        aria-label={t`Delivery uncertain`}
                        className="size-3 text-destructive"
                      />
                    ) : null}
                    {removed ? <span className="text-[10px]">{t`Removed`}</span> : null}
                  </span>
                </button>
                <div className="flex shrink-0 items-center">
                  {row.placement?.kind === "project" ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t`Project bound`}
                      disabled={rowDisabled}
                      onClick={() => onOpenComputer?.()}
                      className="shrink-0 text-muted-foreground"
                    >
                      <Monitor aria-hidden className="size-3.5" />
                    </Button>
                  ) : (
                    <span className="size-7 shrink-0" aria-hidden />
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={t`Options for queued message: ${row.text || "attachment"}`}
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="shrink-0 text-muted-foreground"
                        />
                      }
                    >
                      <MoreHorizontal aria-hidden className="size-3.5" />
                    </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={
                        rowDisabled ||
                        Boolean(selected) ||
                        !rows.slice(0, index).some((item) => item.lane === row.lane)
                      }
                      onClick={() => void mutate({ type: "reorder", id: row.id, direction: -1 })}
                    >
                      <ArrowUp /> {t`Move up`}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={
                        rowDisabled ||
                        Boolean(selected) ||
                        !rows.slice(index + 1).some((item) => item.lane === row.lane)
                      }
                      onClick={() => void mutate({ type: "reorder", id: row.id, direction: 1 })}
                    >
                      <ArrowDown /> {t`Move down`}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={rowDisabled}
                      onClick={() => {
                        const lane = row.lane === "steer" ? "followUp" : "steer";
                        void mutate(
                          selected === row.id
                            ? { type: "edit-patch", patch: { lane } }
                            : { type: "lane", id: row.id, lane },
                        );
                      }}
                    >
                      {row.lane === "steer" ? t`Move to follow-up` : t`Move to steer`}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={rowDisabled}
                      onClick={() =>
                        void mutate(
                          selected === row.id
                            ? { type: "edit-patch", patch: { paused: !row.paused } }
                            : { type: "hold", id: row.id, paused: !row.paused },
                        )
                      }
                    >
                      {row.paused ? t`Release hold` : t`Hold`}
                    </DropdownMenuItem>
                    {row.placement?.kind === "unbound" ? (
                      <DropdownMenuItem
                        disabled={disabled || Boolean(snapshot?.editing) || locked}
                        onClick={() => void mutate({ type: "bind-placement", id: row.id })}
                      >
                        {t`Use current project`}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={rowDisabled}
                      onClick={() =>
                        void mutate(
                          selected === row.id
                            ? { type: "edit-patch", patch: { removed: !removed } }
                            : { type: "remove", id: row.id },
                        )
                      }
                    >
                      {removed ? t`Restore` : t`Remove`}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ol>
      </SpringDisclosure>
      <Dialog open={confirmResume} onOpenChange={setConfirmResume}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Resume uncertain deliveries?`}</DialogTitle>
          </DialogHeader>
          <p>{t`A delivery may already have reached the bot. Resuming can send it again.`}</p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            disabled={
              disabled ||
              locked ||
              Boolean(selected) ||
              Boolean(snapshot?.compaction || snapshot?.gracefulPausePending)
            }
            onClick={async () => {
              if (await mutate({ type: "resume" })) setConfirmResume(false);
            }}
          >
            {t`Resume`}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
});
