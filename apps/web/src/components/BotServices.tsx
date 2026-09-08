import { Trans, useLingui } from "@lingui/react/macro";
import type { ServiceChangesOutput } from "@rakazo/contracts";
import { Button, Input, Toggle } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

const STATUS_DOT: Record<string, string> = {
  running: "bg-success",
  fatal: "bg-destructive",
  exited: "bg-warning",
};

/**
 * Supervised services workbench for one bot's computer. Rendered inside the
 * bot settings inspector: the bot sidebar and composer stay untouched.
 */
export function BotServices({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [state, setState] = useState<{
    supported: boolean;
    services: { name: string; status: string; ports: number[]; keepAlive: boolean }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [port, setPort] = useState("");
  const [preview, setPreview] = useState<{ name: string; src: string } | null>(null);
  const [changes, setChanges] = useState<(ServiceChangesOutput & { cwd: string }) | null>(null);

  async function refresh() {
    try {
      const result = await rpc.services.list({ botId });
      setState({ supported: result.supported, services: result.services });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not load services`);
    }
  }

  useEffect(() => {
    void refresh();
    // Reload when the inspected bot changes; polling stays off to keep this quiet.
  }, [botId]);

  async function act(action: "stop" | "restart" | "remove", service: string) {
    setBusy(true);
    try {
      await rpc.services[action]({ botId, name: service });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Service action failed`);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const argv = command.trim().split(/\s+/).filter(Boolean);
    if (!name.trim() || argv.length === 0) return;
    setBusy(true);
    try {
      await rpc.services.declare({
        botId,
        name: name.trim(),
        argv,
        cwd: cwd.trim() || ".",
        ports: port.trim() ? [Number(port.trim())] : [],
        keepAlive: false,
      });
      setName("");
      setCommand("");
      setPort("");
      setAdding(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not start service`);
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(service: string, rawPort: number | undefined) {
    if (rawPort === undefined) return;
    const port = rawPort;
    try {
      const result = await rpc.services.previewUrl({ botId, name: service, port });
      setPreview({ name: service, src: new URL(result.path, window.location.origin).href });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Preview unavailable`);
    }
  }

  async function loadChanges(cwdValue: string) {
    try {
      const result = await rpc.services.changes({ botId, cwd: cwdValue });
      setChanges({ ...result, cwd: cwdValue });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not read changes`);
    }
  }

  return (
    <div className="mt-4" data-testid="bot-services">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Services</Trans>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {state ? (
        <div className="mt-2 flex flex-col gap-1">
          {state.services.map((service) => (
            <div
              key={service.name}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[14px] hover:bg-muted"
              data-testid="bot-service"
            >
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${STATUS_DOT[service.status] ?? "bg-muted-foreground/40"}`}
              />
              <span className="truncate font-mono text-[13px]">{service.name}</span>
              {service.ports[0] !== undefined && service.status === "running" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-me-1 text-muted-foreground"
                  onClick={() => void openPreview(service.name, service.ports[0])}
                >
                  <Trans>Preview</Trans>
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="-me-1 text-muted-foreground"
                disabled={busy}
                onClick={() => void loadChanges(".")}
              >
                <Trans>Changes</Trans>
              </Button>
              {service.status === "running" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-me-1 text-muted-foreground"
                  disabled={busy}
                  aria-label={t`Stop ${service.name}`}
                  onClick={() => void act("stop", service.name)}
                >
                  <Trans>Stop</Trans>
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-me-1 text-muted-foreground"
                  disabled={busy}
                  aria-label={t`Restart ${service.name}`}
                  onClick={() => void act("restart", service.name)}
                >
                  <Trans>Start</Trans>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="-me-1 text-muted-foreground hover:text-destructive"
                disabled={busy}
                aria-label={t`Remove ${service.name}`}
                onClick={() => void act("remove", service.name)}
              >
                <Trans>Remove</Trans>
              </Button>
            </div>
          ))}
          {state.services.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {state.supported ? (
                <Trans>No services.</Trans>
              ) : (
                <Trans>Service runtime is unavailable on this computer.</Trans>
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      {preview ? (
        <div className="mt-2" data-testid="bot-service-preview">
          <iframe
            src={preview.src}
            title={t`${preview.name} preview`}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            className="h-80 w-full rounded-md border border-border bg-background"
          />
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 text-muted-foreground"
            onClick={() => setPreview(null)}
          >
            <Trans>Close preview</Trans>
          </Button>
        </div>
      ) : null}
      {changes ? (
        <details className="mt-2" data-testid="bot-service-changes">
          <summary className="cursor-pointer text-[13px] text-muted-foreground">
            <Trans>Changes {changes.cwd}</Trans>
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[12px]">
            {changes.branch ? `${changes.branch}\n` : ""}
            {changes.status}
            {changes.diff || (changes.truncated ? "" : t`No unstaged changes.`)}
            {changes.truncated ? t`…truncated` : ""}
          </pre>
        </details>
      ) : null}
      {adding ? (
        <div className="mt-2 flex flex-col gap-2">
          <Input
            value={name}
            maxLength={64}
            data-testid="bot-service-name"
            placeholder={t`Name`}
            aria-label={t`Service name`}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            value={command}
            data-testid="bot-service-command"
            placeholder={t`Command, e.g. npm run dev`}
            aria-label={t`Command`}
            onChange={(e) => setCommand(e.target.value)}
          />
          <Input
            value={cwd}
            maxLength={512}
            placeholder={t`Project directory (. for bot workspace)`}
            aria-label={t`Project directory`}
            onChange={(e) => setCwd(e.target.value)}
          />
          <Input
            value={port}
            inputMode="numeric"
            maxLength={5}
            placeholder={t`Preview port (optional)`}
            aria-label={t`Preview port`}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !name.trim() || !command.trim()}
              onClick={() => void start()}
            >
              <Trans>Start</Trans>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : (
        <Toggle
          variant="outline"
          size="sm"
          className="mt-2"
          data-testid="bot-services-add"
          pressed={false}
          onPressedChange={() => setAdding(true)}
        >
          <Trans>Add service</Trans>
        </Toggle>
      )}
    </div>
  );
}
