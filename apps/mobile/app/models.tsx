import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import {
  modelIdentity,
  modelKey,
  type PiModelSnapshot,
  retainPiInventory,
  searchPiModels,
} from "../lib/pi-models";

export default function Models() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [snapshot, setSnapshot] = useState<PiModelSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoading(true);
      void rpc<PiModelSnapshot>("models/runtime", {})
        .then((next) => {
          if (!active) return;
          setSnapshot((previous) => retainPiInventory(previous, next));
          setError(
            next.availability.status === "unavailable"
              ? next.availability.error || t("Unavailable")
              : null,
          );
        })
        .catch((cause) => {
          if (active) setError(String(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
      return () => {
        active = false;
      };
    }, [revision]),
  );
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <View style={styles.content}>
        <Text style={styles.secondary}>{t("Pi profile default")}</Text>
        <Text style={styles.label}>
          {modelIdentity(snapshot?.profileDefault) || t("Unavailable")}
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={styles.secondary}>
            {error}
          </Text>
        ) : null}
        {loading ? <ActivityIndicator /> : null}
        <Pressable
          accessibilityRole="button"
          disabled={loading}
          onPress={() => setRevision((value) => value + 1)}
          style={styles.button}
        >
          <Text style={styles.label}>{t("Refresh")}</Text>
        </Pressable>
        <TextInput
          accessibilityLabel={t("Search models")}
          placeholder={t("Search models")}
          placeholderTextColor={native.secondaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          value={query}
          onChangeText={setQuery}
          style={styles.input}
        />
        <FlatList
          data={searchPiModels(snapshot?.catalog ?? [], query)}
          keyExtractor={(entry) => modelKey(entry.provider, entry.id)}
          ListEmptyComponent={
            !loading ? <Text style={styles.secondary}>{t("No models")}</Text> : null
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.label}>{item.label}</Text>
              <Text style={styles.secondary}>
                {item.provider}/{item.id}
              </Text>
            </View>
          )}
        />
      </View>
    </SafeAreaView>
  );
}
function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { flex: 1, padding: 20, gap: 12 },
    label: { color: native.label, fontSize: 16 },
    secondary: { color: native.secondaryLabel, fontSize: 14 },
    input: { padding: 14, borderRadius: 12, backgroundColor: native.fill, color: native.label },
    row: { paddingVertical: 14, gap: 4 },
    button: { paddingVertical: 12 },
  });
}
