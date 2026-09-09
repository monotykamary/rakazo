import { Trans, useLingui } from "@lingui/react/macro";
import type { OutgoingMessageDraft, ThreadMessage } from "@rakazo/contracts";
import { Button, Textarea } from "@rakazo/ui-web";
import { Mail, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../lib/artifact-open";
import { authClient } from "../lib/auth";
import { rpc } from "../lib/rpc";

type DraftFields = OutgoingMessageDraft["fields"];
type EditFields = { to: string; cc: string; bcc: string; subject: string; body: string };

function editFields(fields: DraftFields): EditFields {
  return {
    to: fields.to.join("\n"),
    cc: fields.cc?.join("\n") ?? "",
    bcc: fields.bcc?.join("\n") ?? "",
    subject: fields.subject ?? "",
    body: fields.body,
  };
}

function recipients(value: string): string[] {
  return value
    .split(/[\n,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function OutgoingDraftCard({
  draft: incoming,
  approvalEffectId,
  message,
  target,
  canAnswer,
  onRefresh,
}: {
  draft: OutgoingMessageDraft;
  approvalEffectId?: string;
  message: ThreadMessage;
  target: ArtifactTarget;
  canAnswer: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useLingui();
  const session = authClient.useSession();
  const [draft, setDraft] = useState(incoming);
  const [editing, setEditing] = useState<{
    revision: number;
    hash: string;
    fields: EditFields;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    setDraft((current) => {
      if (incoming.revision < current.revision) return current;
      // A delayed pending snapshot must not reopen an already accepted action.
      if (current.status !== "pending" && incoming.status === "pending") return current;
      return incoming;
    });
  }, [incoming]);

  const active =
    draft.status === "pending" &&
    draft.canApprove &&
    Boolean(session.data?.user.id) &&
    draft.ownerUserId === session.data?.user.id &&
    canAnswer &&
    Boolean(approvalEffectId && message.runId) &&
    !acknowledged;
  const labels: Record<OutgoingMessageDraft["status"], string> = {
    pending: t`Awaiting approval`,
    sending: t`Sending`,
    sent: t`Sent`,
    discarded: t`Discarded`,
    failed: t`Failed`,
    uncertain: t`Delivery uncertain`,
    unavailable: t`Unavailable`,
  };
  const fieldLabels = { to: t`To`, cc: t`CC`, bcc: t`BCC`, subject: t`Subject`, body: t`Message` };

  async function act(action: "save" | "send" | "discard") {
    if (locked.current || !active || !approvalEffectId || !message.runId) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action === "save") {
        if (!editing) return;
        const fields = editing.fields;
        const result = await rpc.threads.updateDraft({
          ...target,
          runId: message.runId,
          messageId: message.id,
          approvalEffectId,
          expectedRevision: editing.revision,
          expectedHash: editing.hash,
          fields: {
            to: recipients(fields.to),
            ...(draft.fields.cc !== undefined || draft.editable.includes("cc")
              ? { cc: recipients(fields.cc) }
              : {}),
            ...(draft.fields.bcc !== undefined || draft.editable.includes("bcc")
              ? { bcc: recipients(fields.bcc) }
              : {}),
            ...(draft.fields.subject !== undefined || draft.editable.includes("subject")
              ? { subject: fields.subject }
              : {}),
            body: fields.body,
          },
        });
        setDraft(result.draft);
        setEditing(null);
      } else {
        await rpc.threads.answer({
          ...target,
          runId: message.runId,
          messageId: message.id,
          answer: action,
          expectedDraft: { revision: draft.revision, hash: draft.hash },
        });
        // This is only an acknowledgement, never evidence of delivery.
        setAcknowledged(true);
        setEditing(null);
      }
      try {
        await onRefresh();
      } catch {
        setError(t`Could not refresh draft`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not update draft`);
      // Reconcile stale revisions or a lost acknowledgement without losing local edits.
      await onRefresh().catch(() => undefined);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  function field(name: keyof EditFields, value: string | undefined) {
    if (value === undefined && !(editing && draft.editable.includes(name))) return null;
    const editable = editing && active && draft.editable.includes(name);
    return (
      <div key={name} className="min-w-0 space-y-1">
        <div className="text-xs text-muted-foreground">{fieldLabels[name]}</div>
        {editable ? (
          <Textarea
            aria-label={fieldLabels[name]}
            rows={name === "body" ? 4 : 1}
            className="min-h-9 resize-none whitespace-pre-wrap wrap-anywhere"
            value={editing.fields[name]}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              setEditing(
                (current) =>
                  current && {
                    ...current,
                    fields: { ...current.fields, [name]: value },
                  },
              );
            }}
          />
        ) : (
          <div className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed" dir="auto">
            {value}
          </div>
        )}
      </div>
    );
  }

  return (
    <section
      data-testid="outgoing-draft-card"
      aria-label={t`Email draft`}
      aria-busy={busy}
      className="w-full min-w-0 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Mail aria-hidden="true" className="size-4 shrink-0" />
        <span className="text-sm font-medium">
          <Trans>Email</Trans>
        </span>
        <span role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
          {labels[draft.status]}
        </span>
        {active && !editing && draft.editable.length > 0 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Edit draft`}
            disabled={busy}
            onClick={() => {
              setError(null);
              setEditing({
                revision: draft.revision,
                hash: draft.hash,
                fields: editFields(draft.fields),
              });
            }}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
      </header>
      <div className="space-y-3 px-4 py-4">
        {draft.account ? (
          <div className="space-y-1 text-sm wrap-anywhere">
            <div className="text-xs text-muted-foreground">
              <Trans>Account</Trans>
            </div>
            <div>{draft.account.label}</div>
          </div>
        ) : null}
        {field("to", draft.fields.to.join("\n"))}
        {field("cc", draft.fields.cc?.length ? draft.fields.cc.join("\n") : undefined)}
        {field("bcc", draft.fields.bcc?.length ? draft.fields.bcc.join("\n") : undefined)}
        {field("subject", draft.fields.subject)}
        {field("body", draft.fields.body)}
        {draft.metadata?.map((item, index) => (
          <div key={index} className="space-y-1 text-sm">
            <div className="whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">
              {item.label}
            </div>
            <div className="whitespace-pre-wrap wrap-anywhere" dir="auto">
              {item.value}
            </div>
          </div>
        ))}
        {draft.error ? (
          <p role="alert" className="whitespace-pre-wrap wrap-anywhere text-sm text-destructive">
            {draft.error}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="whitespace-pre-wrap wrap-anywhere text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {active ? (
        <footer className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          {editing ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void act("save")}>
                {busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setError(null);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={() => void act("send")}>
                <Trans>Send</Trans>
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("discard")}>
                <Trans>Discard</Trans>
              </Button>
            </>
          )}
        </footer>
      ) : null}
    </section>
  );
}
