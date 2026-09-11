import type { ProductEvent } from "@rakazo/contracts";

export type ParticipantChatTurn = {
  id: string;
  role: "user" | "bot";
  text: string;
  speakerName?: string;
};

function turnText(payload: ProductEvent["payload"]) {
  for (const key of ["text", "toolName", "name", "activity", "status", "summary"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
}

export function eventBelongsToParticipant(event: ProductEvent, participantId: string) {
  const payload = event.payload;
  if (payload.participantId === participantId) return true;
  if (event.type === "thread.subagent" && payload.agentId === participantId) return true;
  return false;
}

export function participantConversationEvents(
  events: readonly ProductEvent[],
  participantId: string,
) {
  return events.filter((event) => eventBelongsToParticipant(event, participantId));
}

export function participantChatTurns(
  events: readonly ProductEvent[],
  participantId: string,
): ParticipantChatTurn[] {
  const turns: ParticipantChatTurn[] = [];
  for (const event of participantConversationEvents(events, participantId)) {
    if (event.type === "thread.subagent") {
      const task = typeof event.payload.task === "string" ? event.payload.task.trim() : "";
      const result = typeof event.payload.result === "string" ? event.payload.result.trim() : "";
      const name = typeof event.payload.name === "string" ? event.payload.name : undefined;
      if (task) turns.push({ id: `${event.id}:task`, role: "user", text: task });
      if (result) {
        turns.push({ id: `${event.id}:result`, role: "bot", text: result, speakerName: name });
      }
      continue;
    }
    const text = turnText(event.payload);
    if (!text) continue;
    const lane = "lane" in event.payload ? event.payload.lane : undefined;
    const queued = lane === "steer" || lane === "followUp";
    turns.push({
      id: event.id,
      role: queued ? "user" : "bot",
      text,
      speakerName: typeof event.payload.name === "string" ? event.payload.name : undefined,
    });
  }
  return turns;
}

export function queueTurnsForParticipant(
  rows: readonly {
    id: string;
    text: string;
    target?: { participantId: string };
  }[],
  participantId: string,
  speakerName?: string,
): ParticipantChatTurn[] {
  return rows.flatMap((row) => {
    if (row.target?.participantId !== participantId) return [];
    const text = row.text.trim();
    if (!text) return [];
    return [{ id: row.id, role: "user" as const, text, speakerName }];
  });
}

export function projectParticipantChat(input: {
  events: readonly ProductEvent[];
  participantId: string;
  parentName?: string;
  participantName?: string;
  queueRows?: readonly {
    id: string;
    text: string;
    target?: { participantId: string };
  }[];
}): ParticipantChatTurn[] {
  const history = participantChatTurns(input.events, input.participantId).map((turn) =>
    turn.role === "user"
      ? { ...turn, speakerName: turn.speakerName ?? input.parentName }
      : { ...turn, speakerName: turn.speakerName ?? input.participantName },
  );
  const seen = new Set(history.map((turn) => turn.text));
  const pending = queueTurnsForParticipant(
    input.queueRows ?? [],
    input.participantId,
    input.parentName,
  ).filter((turn) => !seen.has(turn.text));
  return [...history, ...pending];
}
