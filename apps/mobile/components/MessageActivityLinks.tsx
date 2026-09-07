import type { MessageActivity } from "@rakazo/core";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { BotAvatar } from "./bot-avatar";
import { NativeSymbol } from "./native-symbol";

export function MessageActivityLinks({
  activities,
  peerBot,
  onPeer,
  onExecution,
  onRoutine,
}: {
  activities: readonly MessageActivity[];
  peerBot: (botId: string) => { color: string } | undefined;
  onPeer: (peer: { botId?: string; peerBotId: string; peerBotName: string }) => void;
  onExecution: (runId: string, botId?: string) => void;
  onRoutine: (routineId: string, botId?: string) => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  return (
    <View style={styles.links}>
      {activities.map((activity) =>
        activity.kind === "peer" ? (
          <Pressable
            key={`peer:${activity.botId}:${activity.peerBotId}`}
            accessibilityRole="button"
            accessibilityLabel={
              activity.count === 1
                ? t("1 message with {peer}", { peer: activity.peerBotName })
                : t("{count} messages with {peer}", {
                    count: activity.count,
                    peer: activity.peerBotName,
                  })
            }
            onPress={() => onPeer(activity)}
            style={styles.link}
          >
            <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
              {activity.count === 1
                ? t("1 message with")
                : t("{count} messages with", { count: activity.count })}
            </Text>
            <BotAvatar
              color={peerBot(activity.peerBotId)?.color ?? tokens.mutedForeground}
              identity={activity.peerBotId}
              size={16}
            />
            <Text
              numberOfLines={1}
              style={{ color: tokens.mutedForeground, fontSize: 13, flexShrink: 1 }}
            >
              {activity.peerBotName}
            </Text>
          </Pressable>
        ) : activity.kind === "routine" ? (
          <Pressable
            key={`routine:${activity.action}:${activity.routineId}`}
            accessibilityRole="button"
            onPress={() => onRoutine(activity.routineId, activity.botId)}
            style={styles.link}
          >
            <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
              {activity.action === "updated" ? t("Updated routine") : t("Created routine")}
            </Text>
            <NativeSymbol
              ios="clock"
              android="time-outline"
              size={14}
              color={tokens.mutedForeground}
            />
            <Text
              numberOfLines={1}
              style={{ color: tokens.mutedForeground, fontSize: 13, flexShrink: 1 }}
            >
              {activity.name}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            key={`execution:${activity.runId}`}
            accessibilityRole="button"
            onPress={() => onExecution(activity.runId, activity.botId)}
            style={styles.link}
          >
            <NativeSymbol
              ios="waveform.path"
              android="pulse-outline"
              size={14}
              color={tokens.mutedForeground}
            />
            <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{t("Execution")}</Text>
          </Pressable>
        ),
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  links: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    maxWidth: "100%",
  },
});
