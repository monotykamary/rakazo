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
    turns.push({
      id: event.id,
      role: "bot",
      text,
      speakerName: typeof event.payload.name === "string" ? event.payload.name : undefined,
    });
  }
  return turns;
}
