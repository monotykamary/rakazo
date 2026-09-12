import type { QueueControlCommand, QueueTarget } from "@rakazo/contracts";
import { itemCommand, type QueuePorts } from "pi-queue-steer-factory/headless";

type ParsedCommand = Parameters<NonNullable<QueuePorts["command"]>>[1];

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Translate TUI command rows. This never produces shell or native slash-command text. */
export function translateQueueControl(
  command: ParsedCommand,
  target?: QueueTarget,
): QueueControlCommand {
  const scoped = <T extends object>(value: T): T & { participantId?: string } =>
    target ? { ...value, participantId: target.participantId } : value;
  if (command.kind === "compact")
    return scoped({
      kind: "compact" as const,
      ...(command.instructions ? { instructions: command.instructions } : {}),
    });
  if (command.kind === "fabric-await") {
    if (target && command.peer && command.peer !== target.participantId)
      throw new Error("Gate participant differs from the queued target");
    const participantId = target?.participantId ?? command.peer;
    if (!participantId) throw new Error("Choose a retained participant for this gate");
    return { kind: "participant-await", participantId };
  }
  if (command.kind === "model") {
    if (!command.target?.includes("/"))
      throw new Error("Queued /model requires an exact provider/model identity");
    return scoped({ kind: "model" as const, target: command.target });
  }
  if (command.kind === "thinking") {
    if (!command.level || !thinkingLevels.has(command.level))
      throw new Error("Queued /thinking requires a supported level");
    return scoped({
      kind: "thinking" as const,
      level: command.level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    });
  }
  if (command.kind === "reload") return scoped({ kind: "reload" as const });
  if (command.kind === "new") return scoped({ kind: "new" as const });
  if (command.kind === "fabric-prewalk") return { kind: "fabric-prewalk" };
  throw new Error(`Unsupported queued control: ${String((command as { kind: string }).kind)}`);
}

export function queueRowCommand(row: { text: string; images?: readonly unknown[] }) {
  return itemCommand({
    text: row.text,
    images: [...(row.images ?? [])],
  });
}
