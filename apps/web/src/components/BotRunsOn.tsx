import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  BotDeploymentController,
  currentMachine,
  isLocalManagedOrigin,
  type MachineGateway,
  type MachineSummary,
  machinePairingCommand,
  orderedMachineChoices,
  type PairingView,
} from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { ChevronRight, Copy, Plus } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { rpc } from "../lib/rpc";

const gateway: MachineGateway = {
  list: () => rpc.machines.list(),
  startPairing: (name) => rpc.machines.startPairing({ name }),
  cancelPairing: async (pairingId) => {
    await rpc.machines.cancelPairing({ pairingId });
  },
  revoke: async (machineId) => {
    await rpc.machines.revoke({ machineId });
  },
  assignment: async (botId) => (await rpc.machines.assignment({ botId })).machineId,
  assign: async (botId, machineId) => {
    await rpc.machines.assign({ botId, machineId });
  },
};

export function BotRunsOn({
  bot,
  onMachineChange,
}: {
  bot: Bot;
  onMachineChange?: (machineId: string | null) => void;
}) {
  const controller = useMemo(() => new BotDeploymentController(gateway, bot.id), [bot.id]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (snapshot.phase === "ready") onMachineChange?.(snapshot.botMachineId);
  }, [snapshot.phase, snapshot.botMachineId, onMachineChange]);

  const current = currentMachine(snapshot.botMachineId, snapshot.machines);
  const pairing = snapshot.pairing;

  return (
    <div className="mt-4" data-testid="bot-runs-on">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Runs on</Trans>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        data-testid="runs-on-trigger"
        onClick={() => setOpen(true)}
      >
        {current ? (
          current.name
        ) : snapshot.botMachineId ? (
          <Trans>Unavailable machine</Trans>
        ) : (
          <Trans>Default machine</Trans>
        )}
        {current?.status === "revoked" ? (
          <span className="text-destructive">
            <Trans>Revoked</Trans>
          </span>
        ) : null}
        <ChevronRight size={14} strokeWidth={1.8} />
      </Button>
      {snapshot.error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {snapshot.error}
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm" data-testid="runs-on-dialog">
          <DialogTitle>
            <Trans>Runs on</Trans>
          </DialogTitle>
          {isLocalManagedOrigin(window.location.origin) ? (
            <p className="text-[13px] text-muted-foreground" data-testid="runs-on-local-warning">
              <Trans>Paired machines pause while this computer sleeps.</Trans>
            </p>
          ) : null}
          {pairing ? <PairingPanel controller={controller} pairing={pairing} /> : null}
          {pairing ? null : (
            <MachineList controller={controller} snapshot={snapshot} current={current} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type Snapshot = ReturnType<BotDeploymentController["getSnapshot"]>;

function MachineList({
  controller,
  snapshot,
  current,
}: {
  controller: BotDeploymentController;
  snapshot: Snapshot;
  current: MachineSummary | null;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [revoking, setRevoking] = useState<MachineSummary | null>(null);
  const choices = orderedMachineChoices(snapshot.machines);
  return (
    <fieldset className="flex min-w-0 flex-col gap-1" aria-label={t`Machine`}>
      <Button
        variant={snapshot.botMachineId === null ? "secondary" : "ghost"}
        aria-pressed={snapshot.botMachineId === null}
        disabled={snapshot.saving}
        data-testid="runs-on-default"
        className="justify-start"
        onClick={() => void controller.choose(null)}
      >
        <Trans>Default machine</Trans>
      </Button>
      {choices.map((machine) => (
        <div key={machine.id} className="flex items-center gap-2">
          <Button
            variant={current?.id === machine.id ? "secondary" : "ghost"}
            aria-pressed={current?.id === machine.id}
            disabled={snapshot.saving}
            data-testid="runs-on-machine"
            onClick={() => void controller.choose(machine.id)}
            className="min-w-0 flex-1 justify-start text-[14px]"
          >
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${machine.status === "online" ? "bg-success" : "bg-muted-foreground/40"}`}
            />
            <span className="truncate">{machine.name}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="-me-1 text-muted-foreground hover:text-destructive"
            disabled={snapshot.saving}
            aria-label={t`Revoke ${machine.name}`}
            onClick={() => setRevoking(machine)}
          >
            <Trans>Revoke</Trans>
          </Button>
        </div>
      ))}
      {adding ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void controller.startPairing(name.trim());
          }}
        >
          <Input
            value={name}
            maxLength={60}
            data-testid="runs-on-machine-name"
            onChange={(event) => setName(event.target.value)}
            placeholder={t`Machine name`}
            aria-label={t`Machine name`}
            className="h-8 flex-1"
          />
          <Button type="submit" size="sm" disabled={!name.trim() || snapshot.saving}>
            <Trans>Pair</Trans>
          </Button>
        </form>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          data-testid="runs-on-add-machine"
          onClick={() => setAdding(true)}
        >
          <Plus size={14} strokeWidth={1.8} />
          <Trans>Add machine</Trans>
        </Button>
      )}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Revoke machine?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>The machine loses access. Its bots stay assigned until you move them.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={snapshot.saving}
              onClick={() => {
                if (revoking) void controller.revoke(revoking.id);
                setRevoking(null);
              }}
            >
              <Trans>Revoke</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </fieldset>
  );
}

function PairingPanel({
  controller,
  pairing,
}: {
  controller: BotDeploymentController;
  pairing: PairingView;
}) {
  const command = machinePairingCommand(window.location.origin, pairing.code);
  if (pairing.phase === "paired") {
    return (
      <Button onClick={() => controller.acknowledgePairing()}>
        <Trans>Choose machine</Trans>
      </Button>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="runs-on-pairing">
      <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate text-[13px]" data-testid="runs-on-pairing-code">
          {command}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Copy pairing command`}
          onClick={() => void navigator.clipboard.writeText(command)}
        >
          <Copy size={14} strokeWidth={1.8} />
        </Button>
      </div>
      {pairing.phase === "waiting" ? (
        <p className="text-[13px] text-muted-foreground">
          <Trans>Waiting for machine…</Trans>
        </p>
      ) : null}
      {pairing.phase === "expired" ? (
        <p className="text-[13px] text-destructive">
          <Trans>Pairing expired.</Trans>
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={
          pairing.phase === "expired"
            ? () => controller.acknowledgePairing()
            : () => void controller.cancelPairing()
        }
      >
        {pairing.phase === "expired" ? <Trans>Try again</Trans> : <Trans>Cancel pairing</Trans>}
      </Button>
    </div>
  );
}
