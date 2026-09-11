import type { ComposerOps } from "@rakazo/core";
import { composerOpsVisible } from "@rakazo/core";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

export function ComposerOpsPills({
  ops,
  onInspectRun,
  onOpenPullRequest,
  onOpenRoutine,
}: {
  ops: ComposerOps;
  onInspectRun?: (runId: string, botId?: string) => void;
  onOpenPullRequest?: (url: string) => void;
  onOpenRoutine?: (routineId: string) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  if (!composerOpsVisible(ops)) return null;

  function present(
    title: string,
    actions: { text: string; onPress: () => void }[],
  ) {
    if (actions.length === 1) {
      actions[0]?.onPress();
      return;
    }
    presentMessageActionSheet({
      title,
      actions,
      cancel: t("Cancel"),
      more: t("More"),
      colorScheme: appearance,
    });
  }

  const pillStyle = {
    borderColor: tokens.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  } as const;

  return (
    <View
      accessibilityRole="summary"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 4, paddingBottom: 8 }}
    >
      {ops.working.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Working, {count}", { count: ops.working.length })}
          onPress={() =>
            present(
              t("Working"),
              ops.working.map((run) => ({
                text: run.name || t("Working"),
                onPress: () => onInspectRun?.(run.id, run.botId),
              })),
            )
          }
          style={pillStyle}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
            {t("Working")} {ops.working.length}
          </Text>
        </Pressable>
      ) : null}
      {ops.pullRequests.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("PRs, {count}", { count: ops.pullRequests.length })}
          onPress={() =>
            present(
              t("PRs"),
              ops.pullRequests.map((pullRequest) => ({
                text: pullRequest.title,
                onPress: () => onOpenPullRequest?.(pullRequest.url),
              })),
            )
          }
          style={pillStyle}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
            {t("PRs")} {ops.pullRequests.length}
          </Text>
        </Pressable>
      ) : null}
      {ops.listening.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Listening, {count}", { count: ops.listening.length })}
          onPress={() =>
            present(
              t("Listening"),
              ops.listening.map((routine) => ({
                text: routine.name,
                onPress: () => onOpenRoutine?.(routine.id),
              })),
            )
          }
          style={pillStyle}
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
            {t("Listening")} {ops.listening.length}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
