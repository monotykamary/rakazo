import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { Menu, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChatTurn } from "../components/ChatTurns";
import { ChatTurns } from "../components/ChatTurns";
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
  turns,
  canSteer,
}: {
  botId: string;
  botName: string;
  botColor: string;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  onOpenNavigation?: () => void;
  onClose: () => void;
  turns?: readonly ChatTurn[];
  canSteer?: boolean;
}) {
  const { t } = useLingui();
  const titleId = useId();
  const viewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    viewRef.current?.focus({ preventScroll: true });
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
  const [historyReady, setHistoryReady] = useState(Boolean(turns));
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
  const chatTurns: ChatTurn[] = useMemo(() => {
    if (turns) return [...turns];
    return (
      conversation?.messages.map((peerMessage, index) => {
        const sent = peerMessage.direction === "sent";
        const turn: ChatTurn = {
          id: `${peerMessage.messageId}-${index}`,
          role: sent ? "user" : "bot",
          text: peerMessage.text,
          speakerName: sent ? botName : peerBotName,
        };
        return turn;
      }) ?? []
    );
  }, [botName, conversation, peerBotName, turns]);

  useEffect(() => {
    if (turns) {
      setHistoryReady(true);
      setHistoryFailed(false);
      return;
    }
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
  }, [botId, peerBotId, reloadKey, turns]);

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
      tabIndex={-1}
      data-testid="peer-conversation-view"
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background text-foreground outline-none"
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
        <Button aria-label={t`Close`} variant="ghost" size="icon-sm" onClick={onClose}>
          <X />
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
      ) : chatTurns.length === 0 ? (
        <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
          <Trans>No messages with {peerBotName} yet.</Trans>
        </div>
      ) : (
        <>
          {olderCursor !== null && !turns ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              <Trans>Load earlier</Trans>
            </Button>
          ) : null}
          {earlierFailed && !turns ? (
            <p role="alert" className="px-4 text-xs text-destructive">
              <Trans>Could not load this chat.</Trans>
            </p>
          ) : null}
          <ChatTurns turns={chatTurns} />
        </>
      )}

      {canSteer ? null : (
        <div className="flex items-center gap-4 border-t border-sidebar-border px-[18px] py-3.5">
          <p className="text-[13.5px] text-muted-foreground/80">
            <Trans>This chat is view-only</Trans>
          </p>
        </div>
      )}
    </section>
  );
}
