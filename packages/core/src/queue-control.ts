import type { QueueControlCommand, QueueTarget } from "@rakazo/contracts";
import type { QueuePorts } from "pi-queue-steer-factory/headless";

type ParsedCommand = Parameters<NonNullable<QueuePorts["command"]>>[1];

/** Translate only reviewed controls. This never produces shell or native slash-command text. */
export function translateQueueControl(
  command: ParsedCommand,
  target?: QueueTarget,
): QueueControlCommand {
  if (command.kind === "compact")
    return {
      kind: "compact",
      ...(command.instructions ? { instructions: command.instructions } : {}),
      ...(target ? { participantId: target.participantId } : {}),
    };
  if (command.kind === "fabric-await") {
    if (target && command.peer && command.peer !== target.participantId)
      throw new Error("Gate participant differs from the queued target");
    const participantId = target?.participantId ?? command.peer;
    if (!participantId) throw new Error("Choose a retained participant for this gate");
    return { kind: "participant-await", participantId };
  }
  throw new Error(`Unsupported queued control: ${command.kind}`);
}
