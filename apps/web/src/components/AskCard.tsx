import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock, selectedAskActionLabel } from "@rakazo/core";
import { Button, Input, Textarea } from "@rakazo/ui-web";
import { useState } from "react";
import { HitlStatus } from "./HitlStatus";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function formatAnsweredState(
  answer: string | undefined,
  approval: boolean,
  secret: boolean,
  outcome?: "created" | "cancelled",
  actions?: AskBlock["actions"],
): string {
  if (secret) return t`Saved`;
  if (!answer) return t`Answered`;
  if (!approval) return t`Answered: ${selectedAskActionLabel(answer, actions)}`;
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

function approvalActionLabel(
  id: string,
  fallback: string,
  outcome?: "created" | "cancelled",
): string {
  if (outcome === "created") return t`Create space`;
  if (outcome === "cancelled") return t`Cancel`;
  if (id === "allow") return t`Allow once`;
  if (id === "always") return t`Always allow this tool`;
  if (id === "deny") return t`Deny`;
  return fallback;
}

function secretFieldLabel(purpose: AskBlock["purpose"]): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
}

export function AskCard({
  block,
  canAnswer,
  onAnswer,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (text: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [answer, setAnswer] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;
  const askActions = block.actions;
  const secretInput = isSecretAskBlock(block);
  const secretLabel = secretFieldLabel(block.purpose);
  const pending = block.status !== "answered" && canAnswer;
  const statusTone = pending ? "need" : block.status === "answered" ? "done" : "ready";

  async function submitAnswer(value: string) {
    if (submitting) return;
    if (secretInput ? value.length === 0 : !value.trim()) return;
    const submitValue = secretInput ? value : value.trim();
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    if (secretInput) setAnswer("");
    try {
      await onAnswer(submitValue);
    } catch (err) {
      setError(
        !secretInput && err instanceof Error ? err.message : t`Could not submit this answer`,
      );
    } finally {
      setPendingAction(null);
    }
  }

  const body = (
    <>
      <div className="text-[15.5px] leading-[1.5] text-foreground">
        <ChatMarkdown>{block.text}</ChatMarkdown>
      </div>
      {secretInput && block.credential ? (
        <div className="mt-2 break-all text-[13px] text-muted-foreground">
          {block.credential.origin}
        </div>
      ) : null}
      {block.detail && !secretInput ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground">
          {block.detail}
        </pre>
      ) : null}
    </>
  );

  if (secretInput) {
    return (
      <div
        data-testid="secret-ask-card"
        className="max-w-[74%] rounded-2xl border border-border bg-card px-5 py-4"
      >
        {body}
        {block.status === "answered" ? (
          <div className="mt-3.5 text-[13.5px] font-medium text-success">
            {formatAnsweredState(block.answer, false, true)}
          </div>
        ) : !canAnswer ? (
          <div className="mt-3.5 text-[13.5px] font-medium text-muted-foreground">
            <Trans>No longer active</Trans>
          </div>
        ) : (
          <form
            className="mt-3.5 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAnswer(answer);
            }}
          >
            <Input
              aria-label={secretLabel}
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={secretLabel}
            />
            <Button
              type="submit"
              className="self-start"
              disabled={answer.length === 0 || submitting}
            >
              {submitting ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          </form>
        )}
        {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div
      data-testid="ask-card"
      className="w-full max-w-xl rounded-2xl border border-border bg-card px-[18px] py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] font-medium text-foreground">
          <Trans>Question</Trans>
        </span>
        <HitlStatus tone={statusTone}>
          {pending ? (
            <Trans>Needs you</Trans>
          ) : block.status === "answered" ? (
            <Trans>Handled</Trans>
          ) : (
            <Trans>No longer active</Trans>
          )}
        </HitlStatus>
      </div>
      <div className="mt-3">{body}</div>
      {block.status === "answered" ? (
        <div className="mt-3.5 text-[13.5px] text-muted-foreground">
          {formatAnsweredState(
            block.answer,
            Boolean(approvalActions),
            false,
            approvalActions?.find((action) => action.id === block.answer)?.outcome,
            askActions,
          )}
        </div>
      ) : !canAnswer ? null : askActions?.length ? (
        <div className="mt-3.5 space-y-1.5">
          {askActions.map((action) => (
            <Button
              key={action.id}
              variant={approvalActions && action.id === "allow" ? "default" : "outline"}
              className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start font-normal"
              disabled={submitting}
              onClick={() => void submitAnswer(action.id)}
            >
              {pendingAction === action.id ? (
                <Trans>Sending…</Trans>
              ) : approvalActions ? (
                approvalActionLabel(action.id, action.label, action.outcome)
              ) : (
                action.label
              )}
            </Button>
          ))}
        </div>
      ) : (
        <>
          <Textarea
            aria-label={t`Answer`}
            rows={2}
            className="mt-3.5 min-h-16 resize-none"
            value={answer}
            disabled={submitting}
            placeholder={t`Type an answer`}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={submitting} onClick={() => void submitAnswer("approved")}>
              {pendingAction === "approved" ? <Trans>Sending…</Trans> : <Trans>Approve</Trans>}
            </Button>
            <Button
              variant="outline"
              disabled={!answer.trim() || submitting}
              onClick={() => void submitAnswer(answer)}
            >
              {pendingAction && pendingAction !== "approved" ? (
                <Trans>Sending…</Trans>
              ) : (
                <Trans>Send back</Trans>
              )}
            </Button>
          </div>
        </>
      )}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}
