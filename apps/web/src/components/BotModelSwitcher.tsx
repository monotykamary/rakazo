import { t } from "@lingui/core/macro";
import type { ModelSelection } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { PiModelPicker, PiModelStatus } from "./PiModelPicker";

type BotModelSwitcherProps = {
  botId: string;
  desired?: ModelSelection | null;
  onChanged?: () => Promise<void>;
};

export function BotModelSwitcher(props: BotModelSwitcherProps) {
  return <ScopedBotModelSwitcher key={props.botId} {...props} />;
}

function ScopedBotModelSwitcher({ botId, desired, onChanged }: BotModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof rpc.models.runtime>>>();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const revision = useRef(0);
  const saving = useRef(false);
  const edited = useRef(false);
  const refresh = useCallback(
    async (force = false) => {
      if (saving.current) return;
      const request = ++revision.current;
      setLoading(true);
      setError(undefined);
      try {
        const next = await rpc.models.runtime({ botId, ...(force ? { refresh: true } : {}) });
        if (request !== revision.current) return;
        setRuntime(next);
        if (!edited.current) setSelection(next.selection?.requested ?? null);
      } catch {
        if (request === revision.current) setError(t`Could not refresh models`);
      } finally {
        if (request === revision.current) setLoading(false);
      }
    },
    [botId],
  );
  useEffect(() => {
    if (open) void refresh();
    return () => {
      revision.current += 1;
    };
  }, [open, refresh]);
  useEffect(() => {
    if (!open || runtime?.selection?.status !== "pending" || busy || loading || error) return;
    const timer = setTimeout(() => void refresh(), 2000);
    return () => clearTimeout(timer);
  }, [open, runtime, busy, loading, error, refresh]);

  async function save(next: ModelSelection | null) {
    if (saving.current || loading || error || runtime?.availability.status !== "available") return;
    saving.current = true;
    const request = ++revision.current;
    setBusy(true);
    setError(undefined);
    try {
      await rpc.bots.update({
        botId,
        modelProvider: next?.provider ?? null,
        modelId: next?.modelId ?? null,
        thinkingLevel: next?.thinkingLevel ?? null,
      });
      // The bot preference is persisted, not necessarily applied to the running session.
      if (request !== revision.current) return;
      edited.current = false;
      setSelection(next);
      setRuntime(
        (previous) =>
          previous && {
            ...previous,
            selection: {
              requested: next,
              effective: previous.current,
              status: "pending",
              error: null,
            },
          },
      );
      void onChanged?.().catch(() => undefined);
      saving.current = false;
      await refresh();
    } catch {
      if (request === revision.current) setError(t`Could not switch model`);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const selected = runtime?.catalog.find(
    (entry) => entry.provider === selection?.provider && entry.id === selection?.modelId,
  );
  const available = runtime?.availability.status === "available";
  const locked = loading || busy || !available || Boolean(error);
  const supported =
    !selection?.thinkingLevel || selected?.thinkingLevels?.includes(selection.thinkingLevel);

  const persisted = runtime ? runtime.selection?.requested : desired;
  const displayed = persisted ?? runtime?.current ?? runtime?.profileDefault;
  const persistedEntry = runtime?.catalog.find(
    (entry) => entry.provider === displayed?.provider && entry.id === displayed?.modelId,
  );
  const headerLabel = persistedEntry?.label ?? displayed?.modelId ?? t`Model`;
  const pending = runtime?.selection?.status === "pending" && Boolean(persisted || runtime.current);
  const headerTitle = persisted
    ? `${t`Selected`}: ${persisted.provider}/${persisted.modelId}${pending ? ` · ${t`Pending`}` : ""}`
    : t`Use Pi selection`;
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (busy) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        data-testid="bot-model-switcher"
        aria-label={t`Model`}
        title={headerTitle}
        render={
          <Button
            variant="ghost"
            size="sm"
            className="app-no-drag h-[30px] shrink-0 gap-1 rounded-[9px] px-2 text-foreground/75"
          />
        }
      >
        <span className="max-w-24 truncate sm:max-w-40">
          {headerLabel}
          {pending ? ` · ${t`Pending`}` : ""}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="rk-scroll max-h-[calc(100dvh-6rem)] w-[min(360px,calc(100vw-2rem))] gap-4 overflow-y-auto p-4"
        aria-busy={loading || busy}
      >
        <PopoverTitle className="sr-only">{t`Model`}</PopoverTitle>
        {runtime && (
          <div aria-live="polite" className="break-all">
            <PiModelStatus current={runtime.current} status={runtime.selection} />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!loading && runtime?.availability.status === "unavailable" && (
          <p role="alert" className="text-sm text-destructive">{t`Pi unavailable`}</p>
        )}
        {!loading && available && !runtime.catalog.length && (
          <p className="text-sm text-muted-foreground">{t`No models available`}</p>
        )}
        {available && runtime.catalog.length > 0 && (
          <PiModelPicker
            catalog={runtime.catalog}
            selection={selection}
            disabled={locked}
            onChange={(next) => {
              edited.current = true;
              setSelection(next);
            }}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={locked || !selected || !supported}
            onClick={() => void save(selection)}
          >
            {busy ? t`Switching…` : t`Use model`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => void save(null)}
          >{t`Use Pi selection`}</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || loading}
            onClick={() => void refresh(true)}
          >
            {loading ? t`Refreshing…` : t`Refresh`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
