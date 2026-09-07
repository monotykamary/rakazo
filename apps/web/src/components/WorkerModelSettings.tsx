import { t } from "@lingui/core/macro";
import type { ModelSelection, ModelSelectionStatus, ThinkingLevel } from "@rakazo/contracts";
import { isModelHidden } from "@rakazo/contracts";
import { connectedModelOptions, modelOptionKey } from "@rakazo/core";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function WorkerModelSettings({
  botId,
  threadId,
  participantId,
}: {
  botId: string;
  threadId: string;
  participantId: string;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ReturnType<typeof connectedModelOptions>>([]);
  const [status, setStatus] = useState<ModelSelectionStatus>();
  const [key, setKey] = useState("");
  const [thinking, setThinking] = useState<ThinkingLevel | "">("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReady(false);
    setStatus(undefined);
    setError(undefined);
    void Promise.all([
      rpc.models.credentials(),
      rpc.models.list(),
      rpc.models.getSelection({ botId, threadId, participantId }),
      rpc.models.getVisibility(),
    ])
      .then(([credentials, catalog, selection, visibility]) => {
        if (cancelled) return;
        setOptions(
          connectedModelOptions(credentials, catalog).filter(
            (option) => !isModelHidden(visibility, option.provider, option.modelId),
          ),
        );
        setStatus(selection);
        setReady(true);
        const model = selection.requested;
        setKey(model ? modelOptionKey(model.provider, model.modelId) : "");
        setThinking(model?.thinkingLevel ?? "");
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, botId, threadId, participantId]);
  useEffect(() => {
    if (!open || status?.status !== "pending") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void rpc.models
        .getSelection({ botId, threadId, participantId })
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch((cause) => {
          if (!cancelled) setError(String(cause));
        });
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, status?.status, botId, threadId, participantId]);
  const selected = options.find((option) => option.key === key);
  async function save(selection: ModelSelection | null) {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await rpc.models.setWorkerSelection({
        botId,
        threadId,
        participantId,
        selection,
      });
      setStatus(next);
      setKey(next.requested ? modelOptionKey(next.requested.provider, next.requested.modelId) : "");
      setThinking(next.requested?.thinkingLevel ?? "");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >{t`Model`}</Button>
      {open && (
        <div className="space-y-2">
          <NativeSelect
            aria-label={t`Model`}
            value={key}
            disabled={busy}
            onChange={(event) => {
              setKey(event.target.value);
              setThinking("");
            }}
          >
            <NativeSelectOption value="">{t`Model`}</NativeSelectOption>
            {key && !selected && (
              <NativeSelectOption value={key} disabled>
                {status?.requested?.modelId ?? key} · {t`Unavailable`}
              </NativeSelectOption>
            )}
            {options.map((option) => (
              <NativeSelectOption key={option.key} value={option.key}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {selected?.thinkingLevels.length ? (
            <NativeSelect
              aria-label={t`Thinking`}
              value={thinking}
              disabled={busy}
              onChange={(event) => setThinking(event.target.value as ThinkingLevel | "")}
            >
              <NativeSelectOption value="">{t`Default`}</NativeSelectOption>
              {selected.thinkingLevels.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {level}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {status &&
            status.status !== "applied" &&
            (status.status === "pending" || status.effective) && (
              <p className="text-xs text-muted-foreground">
                {status.status === "pending" ? t`Pending` : ""}
                {status.effective
                  ? `${status.status === "pending" ? " · " : ""}${t`Effective`}: ${status.effective.modelId}`
                  : ""}
              </p>
            )}
          {(error || status?.error) && (
            <p role="alert" className="text-xs text-destructive">
              {error || status?.error}
            </p>
          )}
          <Button
            size="sm"
            disabled={busy || !ready || !selected}
            onClick={() =>
              selected &&
              void save({
                provider: selected.provider,
                modelId: selected.modelId,
                thinkingLevel: thinking || null,
              })
            }
          >{t`Save`}</Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !ready}
            onClick={() => void save(null)}
          >{t`Use bot model`}</Button>
        </div>
      )}
    </div>
  );
}
