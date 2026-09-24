import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MachineEgressSnapshot } from "@rakazo/contracts";
import { Label, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc, selectedSpaceId } from "../lib/rpc";

const empty: MachineEgressSnapshot = {
  enabled: false,
  hostConnected: false,
  activeConnections: 0,
  sessionTotal: 0,
};

export function OfficeEgressControls() {
  const desktop = desktopBridge();
  const switchId = useId();
  const [snapshot, setSnapshot] = useState<MachineEgressSnapshot>(empty);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!desktop?.egress) return;
    let cancelled = false;
    void rpc.machines.egress.get().then((next) => {
      if (!cancelled) setSnapshot(next);
    });
    const stop = desktop.egress.onChange((state) => {
      setSnapshot((current) => ({
        ...current,
        hostConnected: state.connected,
        activeConnections: state.activeConnections,
        sessionTotal: state.sessionTotal,
      }));
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [desktop]);

  if (!desktop?.egress) return null;

  async function toggle(enabled: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      const next = await rpc.machines.egress.set({ enabled });
      setSnapshot(next);
      const spaceId = selectedSpaceId();
      if (enabled && spaceId) await desktop?.egress?.start(spaceId);
      else await desktop?.egress?.stop();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border px-2 py-2" data-testid="office-egress">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] text-foreground">
            <Trans>Egress</Trans>
          </div>
          <Label
            htmlFor={switchId}
            className="mt-1 block text-[13px] font-normal text-foreground/80"
          >
            <Trans>Route egress through this desktop</Trans>
          </Label>
          {snapshot.enabled ? (
            <p
              className="mt-1 text-[12px] text-muted-foreground"
              data-testid="office-egress-status"
            >
              {snapshot.hostConnected ? (
                <Trans>
                  Connected — routing {snapshot.activeConnections} connections (
                  {snapshot.sessionTotal} total this session).
                </Trans>
              ) : (
                <Trans>Disconnected</Trans>
              )}
            </p>
          ) : null}
        </div>
        <Switch
          id={switchId}
          data-testid="office-egress-toggle"
          checked={snapshot.enabled}
          disabled={saving}
          aria-label={t`Route egress through this desktop`}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>
    </div>
  );
}
