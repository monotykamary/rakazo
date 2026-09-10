import { t } from "@lingui/core/macro";
import type { ModelSelection } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { PiModelPicker, PiModelStatus } from "./PiModelPicker";

type ModelScope = { botId: string; threadId: string; participantId?: string };

export function PiRuntimeModelSettings({ botId, threadId, participantId }: ModelScope) {
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof rpc.models.runtime>>>();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const edited = useRef(false);
  const saving = useRef(false);
  const loaded = useRef(false);
  const refresh = useCallback(
    async (force = false) => {
      if (saving.current) return;
      const request = ++revision.current;
      const showLoading = force || !loaded.current;
      if (showLoading) {
        setLoading(true);
        setError(undefined);
      }
      try {
        const next = await rpc.models.runtime({
          botId,
          threadId,
          participantId,
          ...(force ? { refresh: true } : {}),
        });
        if (request !== revision.current) return;
        loaded.current = true;
        setRuntime((previous) =>
          previous &&
          previous.selection?.status === next.selection?.status &&
          previous.current?.provider === next.current?.provider &&
          previous.current?.modelId === next.current?.modelId &&
          previous.current?.thinkingLevel === next.current?.thinkingLevel &&
          previous.selection?.requested?.provider === next.selection?.requested?.provider &&
          previous.selection?.requested?.modelId === next.selection?.requested?.modelId &&
          previous.selection?.requested?.thinkingLevel === next.selection?.requested?.thinkingLevel &&
          previous.catalog.length === next.catalog.length
            ? previous
            : next,
        );
        if (!edited.current) setSelection(next.selection?.requested ?? next.current);
      } catch {
        if (request === revision.current && showLoading) setError(t`Could not refresh models`);
      } finally {
        if (request === revision.current && showLoading) setLoading(false);
      }
    },
    [botId, threadId, participantId],
  );
  useEffect(() => {
    edited.current = false;
    saving.current = false;
    loaded.current = false;
    setBusy(false);
    setRuntime(undefined);
    setSelection(null);
    void refresh();
    return () => {
      revision.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (runtime?.selection?.status !== "pending" || busy) return;
    const timer = setTimeout(() => void refresh(), 2000);
    return () => clearTimeout(timer);
  }, [runtime, busy, refresh]);
  async function save(nextSelection: ModelSelection | null) {
    if (saving.current || loading || !runtime || runtime.availability.status !== "available") return;
    if (nextSelection) {
      const entry = runtime.catalog.find(
        (item) => item.provider === nextSelection.provider && item.id === nextSelection.modelId,
      );
      if (!entry) return;
      if (
        nextSelection.thinkingLevel &&
        !entry.thinkingLevels?.includes(nextSelection.thinkingLevel)
      ) {
        return;
      }
    }
    saving.current = true;
    const request = ++revision.current;
    setBusy(true);
    setError(undefined);
    try {
      const status = await rpc.models.setWorkerSelection({
        botId,
        threadId,
        participantId,
        selection: nextSelection,
      });
      if (request !== revision.current) return;
      setRuntime(
        (current) => current && { ...current, selection: status, current: status.effective },
      );
      edited.current = false;
      setSelection(status.requested ?? status.effective);
    } catch {
      if (request === revision.current) setError(t`Could not switch model`);
    } finally {
      if (request === revision.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  const available = runtime?.availability.status === "available";
  return (
    <div className="space-y-3">
      <PiModelStatus current={runtime?.current ?? null} status={runtime?.selection} />
      {runtime?.availability.status === "unavailable" && (
        <p role="alert" className="text-sm text-destructive">{t`Pi unavailable`}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {available && runtime.catalog.length === 0 && (
        <p className="text-sm text-muted-foreground">{t`No models available`}</p>
      )}
      <PiModelPicker
        catalog={runtime?.catalog ?? []}
        selection={selection}
        disabled={busy || !available}
        showSelectionSummary={false}
        onChange={(next) => {
          edited.current = true;
          setSelection(next);
          void save(next);
        }}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || loading || !available}
          onClick={() => void save(null)}
        >
          {participantId ? t`Use bot model` : t`Use Pi selection`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || loading}
          onClick={() => void refresh(true)}
        >
          {loading ? t`Refreshing…` : t`Refresh`}
        </Button>
      </div>
    </div>
  );
}

export function WorkerModelSettings(scope: ModelScope) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >{t`Model`}</Button>
      {open && (
        <PiRuntimeModelSettings
          key={`${scope.botId}:${scope.threadId}:${scope.participantId ?? ""}`}
          {...scope}
        />
      )}
    </div>
  );
}
