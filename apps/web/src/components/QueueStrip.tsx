import { t } from "@lingui/core/macro";
import type { QueueSnapshot } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, QueueImageSchema } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Textarea } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { queueRows, useQueue } from "../lib/use-queue";
import { ExecutionInspector } from "./ExecutionInspector";

const queueClient = rpc.queue;
type Images = QueueSnapshot["rows"][number]["images"];
export function GroupQueueStrip({
  threadId,
  members,
  runIds,
}: {
  threadId: string;
  members: { botId: string; name: string }[];
  runIds: string[];
}) {
  const [selected, setSelected] = useState(members[0]?.botId ?? "");
  const botId = members.some((member) => member.botId === selected) ? selected : members[0]?.botId;
  if (!botId) return null;
  return (
    <div>
      <select
        aria-label={t`Queue for bot`}
        className="mx-4 rounded border border-border bg-background p-2 text-sm"
        value={botId}
        onChange={(event) => setSelected(event.target.value)}
      >
        {members.map((member) => (
          <option key={member.botId} value={member.botId}>
            {member.name}
          </option>
        ))}
      </select>
      <QueueStrip key={`${threadId}:${botId}`} threadId={threadId} botId={botId} runIds={runIds} />
    </div>
  );
}
export function QueueStrip({
  threadId,
  botId,
  runIds = [],
}: {
  threadId: string;
  botId: string;
  runIds?: string[];
}) {
  const queue = useQueue(queueClient, threadId, botId);
  const { snapshot, error, busy: queueBusy, mutate } = queue;
  const [attaching, setAttaching] = useState(false);
  const busy = queueBusy || attaching;
  const [open, setOpen] = useState(false);
  const [inspect, setInspect] = useState(false);
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
      <div className="flex flex-wrap gap-2">
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
    <section aria-label={t`Queue`} className="mx-4 rounded-lg border border-border text-sm">
      <div className="flex items-center gap-2 px-2">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t`Queue`} · {snapshot?.rows.length ?? "…"}
        </Button>
        {snapshot?.paused && <span>{t`Paused`}</span>}
        {error || snapshot?.errorHold || snapshot?.uncertainRowIds.length ? (
          <span className="text-destructive">{t`Needs attention`}</span>
        ) : null}
        {runIds.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setInspect(true)}>{t`Execution`}</Button>
        )}
      </div>
      {open && (
        <div className="space-y-3 border-t border-border p-3">
          {(error || attachmentError) && (
            <p role="alert" className="break-words text-destructive">
              {error || attachmentError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                snapshot?.uncertainRowIds.length
                  ? setConfirmResume(true)
                  : void mutate({
                      type: snapshot?.paused || snapshot?.errorHold ? "resume" : "pause",
                    })
              }
            >
              {snapshot?.paused || snapshot?.errorHold ? t`Resume` : t`Pause`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || snapshot?.gracefulPausePending}
              onClick={() => void mutate({ type: "graceful-pause" })}
            >
              {snapshot?.gracefulPausePending ? t`Pause pending` : t`Pause after tools`}
            </Button>
          </div>
          {snapshot?.compaction && (
            <p>
              {t`Compaction`} · {snapshot.compaction}
            </p>
          )}
          {snapshot?.inFlight && (
            <p>
              {t`Delivery pending`} · {snapshot.inFlight.rowIds.join(", ")}
            </p>
          )}
          {snapshot?.errorHold && <p role="status">{t`Recovery hold`}</p>}
          <ol className="max-h-72 space-y-2 overflow-auto" aria-label={t`Execution order`}>
            {rows.map((row) => (
              <li
                key={row.id}
                data-row-id={row.id}
                className={`rounded border border-border p-2 ${row.lane === "steer" ? "ms-6" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">
                    {row.lane === "steer" ? t`Steer` : t`Follow-up`}
                  </span>
                  {row.paused && <span>{t`Held`}</span>}
                  {snapshot?.uncertainRowIds.includes(row.id) && (
                    <span className="text-destructive">{t`Delivery uncertain`}</span>
                  )}
                  {"removed" in row && Boolean(row.removed) && <span>{t`Removed on save`}</span>}
                </div>
                {row.target && (
                  <details>
                    <summary>{t`Participant`}</summary>
                    {row.target.participantId}
                  </details>
                )}
                {row.placement?.kind === "unbound" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || Boolean(snapshot?.editing) || Boolean(snapshot?.inFlight)}
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
                    />
                    {previews(draftImages, setDraftImages)}
                    <input
                      aria-label={t`Add attachments`}
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
                      disabled={disabled || Boolean(selected)}
                      onClick={async () => {
                        if (await mutate({ type: "edit-begin", id: row.id })) {
                          setDraft(row.text);
                          setDraftImages(row.images);
                        }
                      }}
                    >{t`Edit`}</Button>
                  </>
                )}
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || Boolean(selected)}
                    onClick={() => void mutate({ type: "reorder", id: row.id, direction: -1 })}
                    aria-label={t`Move up`}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || Boolean(selected)}
                    onClick={() => void mutate({ type: "reorder", id: row.id, direction: 1 })}
                    aria-label={t`Move down`}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || Boolean(selected)}
                    onClick={() =>
                      void mutate({
                        type: "lane",
                        id: row.id,
                        lane: row.lane === "steer" ? "followUp" : "steer",
                      })
                    }
                  >
                    {row.lane === "steer" ? t`Follow-up` : t`Steer`}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || Boolean(selected)}
                    onClick={() => void mutate({ type: "hold", id: row.id, paused: !row.paused })}
                  >
                    {row.paused ? t`Release hold` : t`Hold`}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || Boolean(selected)}
                    onClick={() => void mutate({ type: "remove", id: row.id })}
                  >{t`Remove`}</Button>
                </div>
              </li>
            ))}
          </ol>
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
            <input
              disabled={busy}
              className="min-w-0 max-w-full"
              aria-label={t`Add attachments`}
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
                }
              }}
            >{t`Queue message`}</Button>
          </div>
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
            disabled={busy}
            onClick={async () => {
              if (await mutate({ type: "resume" })) setConfirmResume(false);
            }}
          >{t`Resume`}</Button>
        </DialogContent>
      </Dialog>
      <Dialog open={inspect} onOpenChange={setInspect}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t`Execution`}</DialogTitle>
          </DialogHeader>
          {inspect && (
            <ExecutionInspector key={`${threadId}:${botId}`} runIds={runIds} queue={queue} />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
