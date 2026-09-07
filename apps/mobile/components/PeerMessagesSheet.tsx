import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { peerConversations } from "@rakazo/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { BotAvatar } from "./bot-avatar";

export function PeerMessagesSheet({
  botId,
  botName,
  peerBotId,
  peerBotName,
  botColor,
  peerBotColor,
  onClose,
}: {
  botId: string;
  botName: string;
  peerBotId: string;
  peerBotName: string;
  botColor: string;
  peerBotColor: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setFailed(false);
    setMessages([]);
    setOlderCursor(null);
    setLoadingEarlier(false);
    setEarlierFailed(false);
    lifecycle.current = abort;
    void rpc<ThreadMessagePage>("threads/messages", { botId, peerBotId }, { signal: abort.signal })
      .then((page) => {
        if (abort.signal.aborted) return;
        setMessages(page.messages);
        setOlderCursor(page.olderCursor);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [botId, peerBotId, reload]);
  async function loadEarlier() {
    const abort = lifecycle.current;
    if (!abort || abort.signal.aborted || loadingEarlier || olderCursor === null) return;
    setLoadingEarlier(true);
    setEarlierFailed(false);
    try {
      const page = await rpc<ThreadMessagePage>(
        "threads/messages",
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
  const conversation = useMemo(
    () => peerConversations(messages).find((entry) => entry.peerBotId === peerBotId),
    [messages, peerBotId],
  );
  return (
    <Modal visible presentationStyle="pageSheet" animationType="slide" onRequestClose={onClose}>
      <View style={[styles.sheet, { backgroundColor: tokens.background }]}>
        <View style={styles.header}>
          <BotAvatar color={botColor} identity={botId} size={24} />
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={[styles.title, { color: tokens.foreground }]}
          >
            {botName} ↔ {peerBotName}
          </Text>
          <BotAvatar color={peerBotColor} identity={peerBotId} size={24} />
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}>
            <Text style={{ color: tokens.foreground }}>{t("Close")}</Text>
          </Pressable>
        </View>
        {loading ? (
          <ActivityIndicator color={tokens.mutedForeground} />
        ) : failed ? (
          <View style={styles.state}>
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {t("Could not load this chat.")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setReload((value) => value + 1)}
              style={styles.button}
            >
              <Text style={{ color: tokens.foreground }}>{t("Retry now")}</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.messages}>
            {olderCursor !== null && (
              <Pressable
                accessibilityRole="button"
                disabled={loadingEarlier}
                onPress={() => void loadEarlier()}
                style={styles.button}
              >
                <Text style={{ color: tokens.foreground }}>{t("Load earlier")}</Text>
              </Pressable>
            )}
            {earlierFailed && (
              <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
                {t("Could not load this chat.")}
              </Text>
            )}
            {conversation?.messages.map((message, index) => (
              <View
                key={`${message.messageId}:${index}`}
                style={[
                  styles.bubble,
                  {
                    alignSelf: message.direction === "sent" ? "flex-end" : "flex-start",
                    backgroundColor: tokens.muted,
                  },
                ]}
              >
                <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                  {message.direction === "sent" ? botName : peerBotName}
                </Text>
                <ChatMarkdown>{message.text}</ChatMarkdown>
              </View>
            ))}
          </ScrollView>
        )}
        <Text style={[styles.footer, { color: tokens.mutedForeground }]}>
          {t("This chat is view-only")}
        </Text>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  sheet: { flex: 1, paddingTop: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
  title: { flex: 1, fontSize: 16, fontWeight: "600" },
  button: { padding: 12 },
  state: { padding: 24, gap: 12 },
  messages: { padding: 16, gap: 12 },
  bubble: { maxWidth: "90%", padding: 14, borderRadius: 18, gap: 5 },
  footer: { padding: 18, fontSize: 13 },
});
