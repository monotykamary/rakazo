import type { AgentRunRequest, AgentSteeringMessage } from "@rakazo/adapter-kit";

/** One standard text/images delivery, matching Pi's queue-drain semantics. */
export async function deliverPremoveDrain(
  messages: AgentSteeringMessage[],
  attemptId: string,
  control: Pick<Parameters<NonNullable<AgentRunRequest["runtimeBoundary"]>>[1], "deliver">,
): Promise<{ outcome: "accepted" }> {
  await control.deliver(combinePremoveMessages(messages, attemptId));
  return { outcome: "accepted" };
}

/** Join texts FIFO, then append every attachment FIFO in the same prompt. */
export function combinePremoveMessages(
  messages: AgentSteeringMessage[],
  attemptId: string,
): AgentSteeringMessage {
  if (!messages.length) throw new Error("Cannot drain an empty queue");
  return {
    ...messages[0]!,
    id: `queue-drain:${attemptId}`,
    messageId: `queue-drain:${attemptId}`,
    text: messages.map((message) => message.text).join("\n\n"),
    images: messages.flatMap((message) => message.images ?? []),
  };
}
