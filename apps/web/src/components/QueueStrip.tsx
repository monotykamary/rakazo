import { t } from "@lingui/core/macro";
import type { QueueSnapshot } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, QueueImageSchema } from "@rakazo/contracts";
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
  Textarea,
} from "@rakazo/ui-web";
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  ListOrdered,
  MoreHorizontal,
  Paperclip,
  Pause,
  Play,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { queueRows, useQueue } from "../lib/use-queue";

const queueClient = rpc.queue;
type Images = QueueSnapshot["rows"][number]["images"];
export function QueueStrip({
  threadId,
  botId,
  initialOpen,
  open: controlledOpen,
  onOpenChange,
}: {
  threadId: string;
  botId: string;
  runIds?: string[];
  initialOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const queue = useQueue(queueClient, threadId, botId);
  const { snapshot, error, busy: queueBusy, mutate } = queue;
  const [attaching, setAttaching] = useState(false);
  const busy = queueBusy || attaching;
  const [localOpen, setLocalOpen] = useState<boolean | undefined>(initialOpen);
  const [addOpen, setAddOpen] = useState(false);
  const open =
    controlledOpen ?? localOpen ?? Boolean(snapshot?.rows.length || error || snapshot?.errorHold);
  function setOpen(value: boolean) {
    setLocalOpen(value);
    onOpenChange?.(value);
  }
  const [text, setText] = useState("");
  const [images, setImages] = useState<Images>([]);
  const [lane, setLane] = useState<"steer" | "followUp">("followUp");
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<Images>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [confirmResume, setConfirmResume] = useState(false);
  const rows = snapshot ? queueRows(snapshot) : [];
  const selected = snapshot?.editing?.selectedId;
  const disabled = busy || !snapshot;
  const locked = Boolean(snapshot?.inFlight || snapshot?.drain);
  const resuming = !snapshot?.drain && Boolean(snapshot?.paused || snapshot?.errorHold);
  const addInput = useRef<HTMLInputElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const draftId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (draftId.current === selected) return;
    draftId.current = selected;
    const row = snapshot?.editing?.rows.find((item) => item.id === selected);
    if (row) {
      setDraft(row.text);
      setDraftImages(row.images);
    }
  }, [selected, snapshot]);

  async function attach(files: FileList | null, editing: boolean) {
    if (!files || busy) return;
    setAttaching(true);
    const current = editing ? draftImages : images;
    try {
      if (current.length + files.length > ATTACHMENT_MAX_COUNT)
        throw new Error(t`Too many attachments`);
      const additions = await Promise.all(
        Array.from(files).map(async (file) => {
          if (file.size > ATTACHMENT_MAX_BYTES) throw new Error(t`Attachment too large`);
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(t`Could not read attachment`));
            reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
            reader.readAsDataURL(file);
          });
          return QueueImageSchema.parse({ type: "image", mimeType: file.type, data });
        }),
      );
      (editing ? setDraftImages : setImages)([...current, ...additions]);
      setAttachmentError(undefined);
    } catch (cause) {
      setAttachmentError(String(cause));
    } finally {
      setAttaching(false);
    }
  }
  function previews(items: Images, change?: (images: Images) => void) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {items.map((image, index) => (
          <div key={index}>
            <img
              className="h-12 w-12 rounded object-cover"
              alt={t`Attachment ${index + 1}`}
              src={`data:${image.mimeType};base64,${image.data}`}
            />
            {change && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => change(items.filter((_, i) => i !== index))}
              >{t`Remove attachment`}</Button>
            )}
          </div>
        ))}
      </div>
    );
  }
  return (
    <section aria-label={t`Queue`} className="min-w-0 text-sm motion-reduce:transition-none">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t`Queue`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ListOrdered aria-hidden className="size-4" />
          {rows.length > 0 && <span>{rows.length}</span>}
        </Button>
        {open && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={addOpen}
            onClick={() => setAddOpen(!addOpen)}
          >{t`Add queued message`}</Button>
        )}
        {open && (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={
                disabled ||
                Boolean(selected) ||
                (resuming &&
                  (locked || Boolean(snapshot?.compaction || snapshot?.gracefulPausePending)))
              }
              onClick={() =>
                resuming && snapshot?.uncertainRowIds.length
                  ? setConfirmResume(true)
                  : void mutate({
                      type: resuming ? "resume" : "pause",
                    })
              }
            >
              {resuming ? (
                <Play aria-hidden className="size-3 shrink-0" />
              ) : (
                <Pause aria-hidden className="size-3 shrink-0" />
              )}
              {resuming ? t`Resume` : t`Pause`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
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
            >{t`Drain all`}</Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t`Queue options`}
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground"
                  />
                }
              >
                <MoreHorizontal aria-hidden className="size-4 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  closeOnClick={false}
                  disabled={
                    disabled ||
                    snapshot?.gracefulPausePending ||
                    Boolean(snapshot?.compaction) ||
                    Boolean(selected)
                  }
                  onClick={() => void mutate({ type: "graceful-pause" })}
                >
                  {snapshot?.gracefulPausePending ? t`Pause pending` : t`Pause after tools`}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {open && (
        <div className="space-y-2">
          {(error || attachmentError) && (
            <p role="alert" className="break-words text-destructive">
              {error || attachmentError}
            </p>
          )}
          {snapshot?.compaction && <p>{t`Compacting`}</p>}
          {snapshot?.inFlight && <p>{t`Delivery pending`}</p>}
          {snapshot?.errorHold && (
            <p role="status" className="text-muted-foreground">{t`Waiting for recovery`}</p>
          )}
          <ol className="max-h-60 space-y-1 overflow-auto" aria-label={t`Execution order`}>
            {rows.map((row, index) => (
              <li
                key={row.id}
                data-row-id={row.id}
                className={`min-w-0 py-1 ${row.lane === "steer" ? "ms-5 border-s border-border ps-3" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">
                    {row.lane === "steer" && (
                      <CornerDownRight aria-hidden className="me-1 inline size-3" />
                    )}
                    {row.lane === "steer" ? t`Steer` : t`Follow-up`}
                  </span>
                  {row.paused && <span>{t`Held`}</span>}
                  {snapshot?.uncertainRowIds.includes(row.id) && (
                    <span className="text-destructive">{t`Delivery uncertain`}</span>
                  )}
                  {"removed" in row && Boolean(row.removed) && <span>{t`Removed on save`}</span>}
                </div>
                {row.attachments?.map((attachment) => (
                  <span
                    key={attachment.artifactId}
                    className="block truncate text-xs text-muted-foreground"
                  >
                    {attachment.name}
                  </span>
                ))}
                {row.target && (
                  <span className="text-xs text-muted-foreground">{t`Participant targeted`}</span>
                )}
                {row.placement?.kind === "unbound" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || Boolean(snapshot?.editing) || locked}
                    onClick={() => void mutate({ type: "bind-placement", id: row.id })}
                  >{t`Use current project`}</Button>
                )}
                {selected === row.id ? (
                  <>
                    <Textarea
                      aria-label={t`Edit queued message`}
                      value={draft}
                      disabled={busy}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          void mutate({ type: "edit-cancel" });
                        }
                      }}
                    />
                    {previews(draftImages, setDraftImages)}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t`Add attachments`}
                      disabled={busy}
                      onClick={() => editInput.current?.click()}
                    >
                      <Paperclip aria-hidden className="size-4 shrink-0" />
                      {t`Attach`}
                    </Button>
                    <input
                      ref={editInput}
                      hidden
                      aria-label={t`Attachment files`}
                      type="file"
                      multiple
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      disabled={busy}
                      onChange={(event) => {
                        void attach(event.target.files, true);
                        event.target.value = "";
                      }}
                    />
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await mutate({
                            type: "edit-patch",
                            patch: { text: draft, images: draftImages },
                          })
                        )
                          await mutate({ type: "edit-save" });
                      }}
                    >{t`Save`}</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void mutate({ type: "edit-cancel" })}
                    >{t`Cancel`}</Button>
                  </>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap break-words">{row.text}</p>
                    {previews(row.images)}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled || locked || Boolean(selected)}
                      onClick={async () => {
                        if (await mutate({ type: "edit-begin", id: row.id })) {
                          setDraft(row.text);
                          setDraftImages(row.images);
                        }
                      }}
                    >{t`Edit`}</Button>
                  </>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={t`Message options`}
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground"
                      />
                    }
                  >
                    <MoreHorizontal aria-hidden className="size-4 shrink-0" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      closeOnClick={false}
                      disabled={
                        disabled ||
                        locked ||
                        Boolean(selected) ||
                        !rows.slice(0, index).some((item) => item.lane === row.lane)
                      }
                      onClick={() => void mutate({ type: "reorder", id: row.id, direction: -1 })}
                      aria-label={t`Move up`}
                    >
                      <ArrowUp aria-hidden className="size-4" />
                      {t`Move up`}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      closeOnClick={false}
                      disabled={
                        disabled ||
                        locked ||
                        Boolean(selected) ||
                        !rows.slice(index + 1).some((item) => item.lane === row.lane)
                      }
                      onClick={() => void mutate({ type: "reorder", id: row.id, direction: 1 })}
                      aria-label={t`Move down`}
                    >
                      <ArrowDown aria-hidden className="size-4" />
                      {t`Move down`}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      closeOnClick={false}
                      disabled={disabled || locked || Boolean(selected && selected !== row.id)}
                      onClick={() => {
                        const lane = row.lane === "steer" ? "followUp" : "steer";
                        void mutate(
                          selected === row.id
                            ? { type: "edit-patch", patch: { lane } }
                            : { type: "lane", id: row.id, lane },
                        );
                      }}
                    >
                      {row.lane === "steer" ? t`Follow-up` : t`Steer`}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      closeOnClick={false}
                      disabled={disabled || locked || Boolean(selected && selected !== row.id)}
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
                    <DropdownMenuItem
                      closeOnClick={false}
                      disabled={disabled || locked || Boolean(selected && selected !== row.id)}
                      onClick={() =>
                        void mutate(
                          selected === row.id
                            ? {
                                type: "edit-patch",
                                patch: { removed: !("removed" in row && row.removed) },
                              }
                            : { type: "remove", id: row.id },
                        )
                      }
                    >
                      {"removed" in row && row.removed ? t`Restore` : t`Remove`}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ol>
          {addOpen && (
            <>
              <Textarea
                disabled={busy}
                aria-label={t`Queued message`}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              {previews(images, setImages)}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="rounded border border-border bg-background p-2"
                  aria-label={t`Delivery lane`}
                  disabled={busy}
                  value={lane}
                  onChange={(event) => setLane(event.target.value as typeof lane)}
                >
                  <option value="followUp">{t`Follow-up`}</option>
                  <option value="steer">{t`Steer`}</option>
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t`Add attachments`}
                  disabled={busy}
                  onClick={() => addInput.current?.click()}
                >
                  <Paperclip aria-hidden className="size-4 shrink-0" />
                  {t`Attach`}
                </Button>
                <input
                  ref={addInput}
                  hidden
                  disabled={busy}
                  aria-label={t`Attachment files`}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  onChange={(event) => {
                    void attach(event.target.files, false);
                    event.target.value = "";
                  }}
                />
                <Button
                  size="sm"
                  disabled={disabled || (!text.trim() && !images.length)}
                  onClick={async () => {
                    if (await mutate({ type: "enqueue", text, images, lane })) {
                      setText("");
                      setImages([]);
                      setAddOpen(false);
                    }
                  }}
                >{t`Queue message`}</Button>
              </div>
            </>
          )}
        </div>
      )}
      <Dialog open={confirmResume} onOpenChange={setConfirmResume}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Resume uncertain deliveries?`}</DialogTitle>
          </DialogHeader>
          <p>{t`A delivery may already have reached the bot. Resuming can send it again.`}</p>
          {error && (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          )}
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
          >{t`Resume`}</Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
