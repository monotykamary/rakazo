import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  BOT_OFFICE_PROMPTS,
  BotDeploymentController,
  type BotPromptHandler,
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
  Input,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { Copy, Ellipsis, Plus } from "lucide-react";
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
  onPrompt,
  disabled = false,
}: {
  bot: Bot;
  onPrompt: BotPromptHandler;
  disabled?: boolean;
  onMachineChange?: (machineId: string | null) => void;
}) {
  const controller = useMemo(() => new BotDeploymentController(gateway, bot.id), [bot.id]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [open, setOpen] = useState(false);
  const office = currentMachine(snapshot.botMachineId, snapshot.machines);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (snapshot.phase === "ready") onMachineChange?.(snapshot.botMachineId);
  }, [snapshot.phase, snapshot.botMachineId, onMachineChange]);

  const pairing = snapshot.pairing;

  return (
    <div className="mt-4" data-testid="bot-runs-on">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Office</Trans>
      </div>
      <div className="mt-2 flex min-w-0 items-center">
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2 min-w-0 max-w-full font-normal"
          data-testid="runs-on-trigger"
          disabled={disabled || snapshot.phase !== "ready"}
          aria-label={snapshot.botMachineId ? t`Move office` : t`Link office`}
          onClick={() => {
            setOpen(false);
            void onPrompt(
              bot.id,
              snapshot.botMachineId ? BOT_OFFICE_PROMPTS.move : BOT_OFFICE_PROMPTS.link,
            );
          }}
        >
          {office ? (
            <>
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${
                  office.status === "online" ? "bg-success" : "bg-muted-foreground/40"
                }`}
              />
              <span className="truncate">{office.name}</span>
            </>
          ) : snapshot.botMachineId ? (
            <Trans>Move office</Trans>
          ) : (
            <Trans>Link office</Trans>
          )}
        </Button>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label={t`Manage offices`}
            disabled={disabled || snapshot.phase !== "ready"}
            onClick={() => setOpen(true)}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={6}
            className="w-[min(18rem,calc(100vw-2rem))] gap-2 p-2"
            data-testid="runs-on-dialog"
          >
            <PopoverTitle className="sr-only">
              <Trans>Office</Trans>
            </PopoverTitle>
            {isLocalManagedOrigin(window.location.origin) ? (
              <p className="px-1 text-[12px] text-muted-foreground" data-testid="runs-on-local-warning">
                <Trans>Paired machines pause while this computer sleeps.</Trans>
              </p>
            ) : null}
            {pairing ? <PairingPanel controller={controller} pairing={pairing} /> : null}
            {pairing ? null : <MachineList controller={controller} snapshot={snapshot} />}
          </PopoverContent>
        </Popover>
      </div>
      {snapshot.error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {snapshot.error}
        </p>
      ) : null}
    </div>
  );
}

type Snapshot = ReturnType<BotDeploymentController["getSnapshot"]>;

function MachineList({
  controller,
  snapshot,
}: {
  controller: BotDeploymentController;
  snapshot: Snapshot;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [revoking, setRevoking] = useState<MachineSummary | null>(null);
  const choices = orderedMachineChoices(snapshot.machines);
  const naming = adding || choices.length === 0;
  return (
    <fieldset className="flex min-w-0 flex-col gap-0.5" aria-label={t`Machine`}>
      {choices.map((machine) => (
        <div key={machine.id} className="flex items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1 text-[14px]">
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${
                machine.status === "online" ? "bg-success" : "bg-muted-foreground/40"
              }`}
            />
            <span className="truncate">{machine.name}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            disabled={snapshot.saving}
            aria-label={t`Revoke ${machine.name}`}
            onClick={() => setRevoking(machine)}
          >
            <Trans>Revoke</Trans>
          </Button>
        </div>
      ))}
      {naming ? (
        <form
          className="flex items-center gap-1 px-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void controller.startPairing(name.trim());
          }}
        >
          <Input
            value={name}
            maxLength={60}
            autoFocus={adding || choices.length === 0}
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
          variant="ghost"
          size="sm"
          className="self-start font-normal text-muted-foreground"
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
        <Trans>Done</Trans>
      </Button>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="runs-on-pairing">
      <div className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate text-[12px]" data-testid="runs-on-pairing-code">
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
        <p className="px-1 text-[12px] text-muted-foreground">
          <Trans>Waiting for machine…</Trans>
        </p>
      ) : null}
      {pairing.phase === "expired" ? (
        <p className="px-1 text-[12px] text-destructive">
          <Trans>Pairing expired.</Trans>
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="self-start font-normal"
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
