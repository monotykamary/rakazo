import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { HitlStatus } from "./HitlStatus";

export function ComputerTakeoverCard({
  block,
  onOpenComputer,
}: {
  block: Extract<MessageBlock, { kind: "computer" }>;
  onOpenComputer?: () => void;
}) {
  const needsYou = block.state === "Needs you";
  return (
    <div
      data-testid="computer-takeover-card"
      className="w-full max-w-xl rounded-2xl border border-border bg-card px-[18px] py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] font-medium text-foreground">
          <Trans>Take over</Trans>
        </span>
        <HitlStatus tone={needsYou ? "need" : "done"}>
          {needsYou ? <Trans>Needs you</Trans> : block.state || <Trans>Handled</Trans>}
        </HitlStatus>
      </div>
      {block.text ? (
        <div className="my-2.5 text-[14.5px] leading-[1.5] text-foreground/80">
          <ChatMarkdown>{block.text}</ChatMarkdown>
        </div>
      ) : null}
      {needsYou && onOpenComputer ? (
        <Button size="sm" onClick={onOpenComputer}>
          <Trans>Open computer</Trans>
        </Button>
      ) : null}
    </div>
  );
}
