import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PiModelPicker } from "../components/PiModelPicker";
import { rpc } from "../lib/rpc";

export function ModelSettingsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof rpc.models.runtime>>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const refresh = useCallback(async (force = false) => {
    const request = ++revision.current;
    setLoading(true);
    setRuntime(undefined);
    setError(false);
    try {
      const next = await rpc.models.runtime({ ...(force ? { refresh: true } : {}) });
      if (request !== revision.current) return;
      setRuntime(next);
    } catch {
      if (request === revision.current) setError(true);
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      revision.current += 1;
    };
  }, [refresh]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="rk-scroll block max-h-[calc(100%-2rem)] w-[640px] overflow-y-auto overscroll-contain rounded-2xl p-6 sm:max-h-[calc(100%-5rem)] sm:max-w-[calc(100%-5rem)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-6">
          <DialogTitle className="text-2xl font-medium text-foreground">
            <Trans>Models</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </div>
        <section
          data-testid="model-inventory-panel"
          className="mt-8 space-y-4 rounded-xl border border-border p-4"
        >
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              <Trans>Could not refresh models</Trans>
            </p>
          ) : runtime?.availability.status === "unavailable" ? (
            <p role="alert" className="text-sm text-destructive">
              {runtime.availability.error === "PI_NOT_CONFIGURED"
                ? t`Configure the API's Pi runtime`
                : runtime.availability.error === "PI_START_FAILED" ||
                    runtime.availability.error === "PI_DISCONNECTED"
                  ? t`Check the API's Pi command and PATH`
                  : runtime.availability.error === "PI_WORKSPACE_UNAVAILABLE"
                    ? t`Check the API's Pi workspace`
                    : runtime.availability.error === "PI_DISCOVERY_TIMEOUT"
                      ? t`Pi discovery timed out. Retry`
                      : runtime.availability.error === "PI_PROTOCOL_FAILED"
                        ? t`Check Pi RPC compatibility and extension output`
                        : t`Could not refresh models`}
            </p>
          ) : null}
          {runtime?.availability.status === "available" && !runtime.catalog.length && (
            <p className="text-sm text-muted-foreground">
              <Trans>No models available</Trans>
            </p>
          )}
          {!loading &&
            !error &&
            runtime?.availability.status === "available" &&
            runtime.catalog.length > 0 && (
              <PiModelPicker
                catalog={runtime.catalog}
                selection={runtime.profileDefault}
                readOnly
              />
            )}
          {!loading && !error && runtime?.availability.status === "available" && (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">
                <Trans>Pi profile default</Trans>
              </summary>
              <p className="mt-2 break-all" data-testid="pi-profile-default">
                {runtime.profileDefault
                  ? `${runtime.profileDefault.provider}/${runtime.profileDefault.modelId}`
                  : t`Unavailable`}
              </p>
            </details>
          )}
        </section>
        <Button
          variant="ghost"
          size="sm"
          className="mt-5 w-fit rounded-full"
          disabled={loading}
          onClick={() => void refresh(true)}
        >
          {loading ? <Trans>Refreshing…</Trans> : <Trans>Refresh</Trans>}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
