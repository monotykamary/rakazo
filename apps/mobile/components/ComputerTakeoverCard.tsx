import { useRouter } from "expo-router";
import type { MessageBlock } from "@rakazo/contracts";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ComputerTakeoverCard({
  block,
  botId,
}: {
  block: Extract<MessageBlock, { kind: "computer" }>;
  botId?: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const needsYou = block.state === "Needs you";

  return (
    <View
      style={{
        width: "90%",
        borderRadius: 18,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: tokens.foreground, fontSize: 14, fontWeight: "600" }}>{t("Take over")}</Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            borderRadius: 999,
            paddingHorizontal: 11,
            paddingVertical: 4,
            backgroundColor: tokens.muted,
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: needsYou ? tokens.warning : tokens.mutedForeground,
            }}
          />
          <Text style={{ color: needsYou ? tokens.warning : tokens.mutedForeground, fontSize: 13 }}>
            {needsYou ? t("Needs you") : block.state || t("Handled")}
          </Text>
        </View>
      </View>
      {block.text ? (
        <Text style={{ color: tokens.foreground, fontSize: 15, lineHeight: 22 }}>{block.text}</Text>
      ) : null}
      {needsYou && botId ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Open computer")}
          onPress={() => router.push({ pathname: "/computer", params: { botId } })}
          style={{
            alignSelf: "flex-start",
            borderRadius: 999,
            backgroundColor: tokens.primary,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontWeight: "600" }}>{t("Open computer")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
