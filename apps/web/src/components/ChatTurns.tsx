import { ChatMarkdown } from "@rakazo/chat-ui/web";

export type ChatTurn = {
  id: string;
  role: "user" | "bot";
  text: string;
  speakerName?: string;
};

export type OverlayChat = {
  botId?: string;
  peerBotId: string;
  peerBotName: string;
  turns?: readonly ChatTurn[];
  canSteer?: boolean;
};

export function ChatTurns({ turns }: { turns: readonly ChatTurn[] }) {
  return (
    <div
      data-testid="peer-conversation-transcript"
      className="rk-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-5 md:px-7 md:py-6"
    >
      {turns.map((turn) => {
        const sent = turn.role === "user";
        return (
          <div key={turn.id}>
            {turn.speakerName ? (
              <div
                className={`mb-1 text-[12.5px] font-medium text-muted-foreground ${
                  sent ? "text-end" : "text-start"
                }`}
                dir="auto"
              >
                {turn.speakerName}
              </div>
            ) : null}
            <div className={`flex ${sent ? "justify-end" : "justify-start"}`}>
              <div
                data-testid={sent ? "message-user-bubble" : "message-bot-bubble"}
                className={
                  sent
                    ? "max-w-[80%] whitespace-pre-wrap wrap-anywhere rounded-[20px] bg-secondary px-[18px] py-3 text-[14.5px] leading-[1.45] text-secondary-foreground"
                    : "max-w-[80%] rounded-[20px] bg-muted px-[18px] py-3 text-[14.5px] leading-[1.5] text-foreground/90"
                }
                dir="auto"
              >
                {sent ? turn.text : <ChatMarkdown>{turn.text}</ChatMarkdown>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
