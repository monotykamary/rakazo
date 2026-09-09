import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
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
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setRuntime(undefined);
    setError(false);
    try {
      const next = await rpc.models.runtime({});
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
      <DialogContent showCloseButton={false} aria-describedby={undefined} className="sm:max-w-xl">
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle>
            <Trans>Models</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        {!loading && !error && runtime?.availability.status === "available" && (
          <p className="break-all text-sm text-muted-foreground" data-testid="pi-profile-default">
            <Trans>Pi profile default</Trans>:{" "}
            {runtime?.profileDefault
              ? `${runtime.profileDefault.provider}/${runtime.profileDefault.modelId}`
              : t`Unavailable`}
          </p>
        )}
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
            <PiModelPicker catalog={runtime.catalog} selection={runtime.profileDefault} readOnly />
          )}
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? <Trans>Refreshing…</Trans> : <Trans>Refresh</Trans>}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
