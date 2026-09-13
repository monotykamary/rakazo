import { summarizeToolSteps } from "@rakazo/core";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

export function ToolStepsRow({
  steps,
  color,
  identity,
}: {
  steps: readonly { label: string; count: number }[];
  color: string;
  identity: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const summary = summarizeToolSteps(steps);
  if (!summary) return null;
  const countLabel =
    summary.count === 1 ? t("1 step") : t("{count} steps", { count: summary.count });
  const label = `${summary.title} · ${countLabel} · ${summary.latest}`;

  return (
    <View style={{ width: "100%", maxWidth: 420 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        onPress={() => setOpen((current) => !current)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
      >
        <BotAvatar color={color} identity={identity} size={16} />
        <Text numberOfLines={1} style={{ flex: 1, color: tokens.mutedForeground, fontSize: 13.5 }}>
          <Text style={{ color: tokens.foreground, fontWeight: "600" }}>{summary.title}</Text>
          {` · ${countLabel} · ${summary.latest}`}
        </Text>
        <Text style={{ color: tokens.mutedForeground }}>{open ? "⌃" : "⌄"}</Text>
      </Pressable>
      {open
        ? steps.map((step, index) => (
            <View
              key={`${step.label}:${index}`}
              style={{
                marginStart: 24,
                paddingStart: 12,
                borderStartWidth: 1,
                borderStartColor: tokens.border,
                paddingVertical: 4,
                flexDirection: "row",
                gap: 8,
              }}
            >
              <Text style={{ flex: 1, color: tokens.foreground, fontSize: 13 }}>{step.label}</Text>
              {step.count > 1 ? (
                <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>×{step.count}</Text>
              ) : null}
            </View>
          ))
        : null}
    </View>
  );
}
