import type { ServiceListOutput } from "@rakazo/contracts";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { currentApiBase, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

const STATUS_COLOR: Record<string, string> = {
  running: "#22c55e",
  fatal: "#ef4444",
  exited: "#f59e0b",
};

/** Minimal services workbench for the inspected bot's computer. */
export default function BotServicesScreen() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [state, setState] = useState<ServiceListOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!botId) return;
    try {
      setState(await rpc<ServiceListOutput>("services/list", { botId }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not load services"));
    }
  }

  useEffect(() => {
    void refresh();
  }, [botId]);

  async function act(action: "stop" | "restart" | "remove", name: string) {
    setBusy(true);
    try {
      await rpc(`services/${action}`, { botId, name });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Service action failed"));
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(name: string, rawPort: number | undefined) {
    if (rawPort === undefined) return;
    const port = rawPort;
    try {
      const result = await rpc<{ path: string }>("services/previewUrl", { botId, name, port });
      const Linking = (await import("react-native")).Linking;
      await Linking.openURL(new URL(result.path, currentApiBase()).href);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Preview unavailable"));
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen options={{ title: t("Services") }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 14 }}>
            {error}
          </Text>
        ) : null}
        {state?.services.map((service) => (
          <View
            key={service.name}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              padding: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: tokens.border,
            }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: STATUS_COLOR[service.status] ?? tokens.muted,
              }}
            />
            <Text style={{ flex: 1, color: tokens.foreground, fontSize: 14 }} numberOfLines={1}>
              {service.name}
            </Text>
            {service.ports[0] !== undefined && service.status === "running" ? (
              <Pressable
                accessibilityLabel={t("Open preview")}
                disabled={busy}
                onPress={() => void openPreview(service.name, service.ports[0])}
              >
                <Text style={{ color: tokens.primary, fontSize: 13 }}>{t("Preview")}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel={
                service.status === "running"
                  ? t("Stop " + service.name)
                  : t("Start " + service.name)
              }
              disabled={busy}
              onPress={() =>
                void act(service.status === "running" ? "stop" : "restart", service.name)
              }
            >
              <Text style={{ color: tokens.primary, fontSize: 13 }}>
                {service.status === "running" ? t("Stop") : t("Start")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={t("Remove " + service.name)}
              disabled={busy}
              onPress={() => void act("remove", service.name)}
            >
              <Text style={{ color: tokens.destructive, fontSize: 13 }}>{t("Remove")}</Text>
            </Pressable>
          </View>
        ))}
        {state && state.services.length === 0 ? (
          <Text style={{ color: tokens.muted, fontSize: 13 }}>
            {state.supported
              ? t("No services.")
              : t("Service runtime is unavailable on this computer.")}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
