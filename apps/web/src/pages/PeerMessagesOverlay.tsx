import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { Menu } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { peerConversations } from "../lib/peer-messages";
import { rpc } from "../lib/rpc";

// Read-only peer history hosted inside the main conversation pane.
export function PeerMessagesOverlay({
  botId,
  botName,
  botColor,
  peerBotId,
  peerBotName: initialPeerBotName,
  peerBotColor,
  onOpenNavigation,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  onOpenNavigation?: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const titleId = useId();
  const viewRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const view = viewRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    view?.addEventListener("keydown", onKeyDown);
    return () => view?.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const lifecycle = useRef<AbortController | null>(null);
  const conversation = useMemo(() => {
    if (!historyReady) return null;
    return peerConversations(messages).find((entry) => entry.peerBotId === peerBotId) ?? null;
  }, [historyReady, messages, peerBotId]);
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;

  useEffect(() => {
    const abort = new AbortController();
    setHistoryReady(false);
    setHistoryFailed(false);
    setMessages([]);
    setOlderCursor(null);
    setLoadingEarlier(false);
    setEarlierFailed(false);
    lifecycle.current = abort;
    void rpc.threads
      .messages({ botId, peerBotId }, { signal: abort.signal })
      .then((page) => {
        if (abort.signal.aborted) return;
        setMessages(page.messages);
        setOlderCursor(page.olderCursor);
        setHistoryReady(true);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setHistoryFailed(true);
        setHistoryReady(true);
      });
    return () => {
      abort.abort();
    };
  }, [botId, peerBotId, reloadKey]);

  async function loadEarlier() {
    const abort = lifecycle.current;
    if (!abort || abort.signal.aborted || loadingEarlier || olderCursor === null) return;
    setLoadingEarlier(true);
    setEarlierFailed(false);
    try {
      const page = await rpc.threads.messages(
        { botId, peerBotId, before: olderCursor },
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      setMessages((current) => [
        ...page.messages.filter((row) => !current.some((item) => item.id === row.id)),
        ...current,
      ]);
      setOlderCursor(page.olderCursor);
    } catch {
      if (!abort.signal.aborted) setEarlierFailed(true);
    } finally {
      if (!abort.signal.aborted) setLoadingEarlier(false);
    }
  }

  const title = `${botName} · ${peerBotName}`;

  return (
    <section
      ref={viewRef}
      aria-labelledby={titleId}
      data-testid="peer-conversation-view"
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background text-foreground"
    >
      <div className="flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {onOpenNavigation && (
            <Button
              variant="ghost"
              size="icon"
              className="app-no-drag shrink-0 md:hidden"
              aria-label={t`Open navigation`}
              onClick={onOpenNavigation}
            >
              <Menu size={19} strokeWidth={1.7} />
            </Button>
          )}
          <div className="flex items-center -space-x-2">
            <BotAvatar color={botColor} identity={botId} size={28} />
            <BotAvatar color={peerBotColor} identity={peerBotId} size={28} />
          </div>
          <h2
            id={titleId}
            className="truncate text-[15.5px] font-medium text-foreground"
            dir="auto"
          >
            {title}
          </h2>
        </div>
        <Button ref={closeRef} aria-label={t`Close`} variant="ghost" size="sm" onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
      </div>

      {!historyReady ? (
        <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
          <Trans>Loading…</Trans>
        </div>
      ) : historyFailed ? (
        <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
          <div className="flex flex-col items-center gap-3">
            <Trans>Could not load this chat.</Trans>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((value) => value + 1)}>
              <Trans>Retry now</Trans>
            </Button>
          </div>
        </div>
      ) : !conversation || conversation.messages.length === 0 ? (
        <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
          <Trans>No messages with {peerBotName} yet.</Trans>
        </div>
      ) : (
        <div
          data-testid="peer-conversation-transcript"
          className="rk-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-5 md:px-7 md:py-6"
        >
          {olderCursor !== null && (
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              <Trans>Load earlier</Trans>
            </Button>
          )}
          {earlierFailed && (
            <p role="alert" className="text-xs text-destructive">
              <Trans>Could not load this chat.</Trans>
            </p>
          )}
          {conversation.messages.map((peerMessage, index) => {
            const sent = peerMessage.direction === "sent";
            return (
              <div
                key={`${peerMessage.messageId}-${index}`}
                className={`flex ${sent ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                    sent ? "bg-accent" : "bg-muted"
                  }`}
                >
                  <div className="mb-1 text-[12px] text-muted-foreground/70" dir="auto">
                    {sent ? botName : peerBotName}
                  </div>
                  <div className="text-[14.5px] leading-[1.5] text-foreground/90" dir="auto">
                    <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-4 border-t border-sidebar-border px-[18px] py-3.5">
        <p className="text-[13.5px] text-muted-foreground/80">
          <Trans>This chat is view-only</Trans>
        </p>
      </div>
    </section>
  );
}
