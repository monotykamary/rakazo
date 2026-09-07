import type {
  ModelCatalogEntry,
  ModelCredential,
  ModelHideRule,
  ModelVisibility,
} from "@rakazo/contracts";
import { connectedModelOptions } from "@rakazo/core";
import { useEffect, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";

export function ModelVisibilitySettings({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<
    Pick<ModelCatalogEntry, "provider" | "id" | "label" | "placeholder">[]
  >([]);
  const [visibility, setVisibility] = useState<ModelVisibility>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setVisibility(undefined);
    setError(undefined);
    void Promise.all([
      rpc<ModelVisibility>("models/getVisibility", {}),
      rpc<ModelCatalogEntry[]>("models/listForVisibility", {}),
      rpc<ModelCredential[]>("models/credentials", {}),
    ])
      .then(([state, models, credentials]) => {
        if (!cancelled) {
          setVisibility(state);
          const custom = connectedModelOptions(credentials, models).filter(
            (option) =>
              !models.some(
                (model) =>
                  !model.placeholder &&
                  model.provider === option.provider &&
                  model.id === option.modelId,
              ),
          );
          setCatalog([
            ...models,
            ...custom.map((option) => ({
              id: option.modelId,
              provider: option.provider,
              label: option.label,
              thinkingLevels: option.thinkingLevels,
            })),
          ]);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  async function change(rule: ModelHideRule, hide: boolean) {
    if (!visibility || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const rules = visibility.hide.filter(
        (item) => item.provider !== rule.provider || item.model !== rule.model,
      );
      setVisibility(
        await rpc<ModelVisibility>("models/setVisibility", {
          hide: hide ? [...rules, rule] : rules,
        }),
      );
      await onChanged();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  const rows: { rule: ModelHideRule; label: string; hidden: boolean }[] = [
    ...(visibility?.hide ?? []).map((rule) => ({
      rule,
      label: `${rule.provider}${rule.model ? ` · ${rule.model}` : ""}`,
      hidden: true,
    })),
    ...[...new Set(catalog.map((entry) => entry.provider))].flatMap((provider) => {
      if (visibility?.hide.some((rule) => rule.provider === provider && !rule.model)) return [];
      const models = catalog.filter(
        (entry) =>
          !entry.placeholder &&
          entry.provider === provider &&
          `${provider} ${entry.label} ${entry.id}`.toLowerCase().includes(query.toLowerCase()) &&
          !visibility?.hide.some((rule) => rule.provider === provider && rule.model === entry.id),
      );
      return models.length || provider.toLowerCase().includes(query.toLowerCase())
        ? [
            { rule: { provider }, label: provider, hidden: false },
            ...models.map((entry) => ({
              rule: { provider, model: entry.id },
              label: entry.label,
              hidden: false,
            })),
          ]
        : [];
    }),
  ];
  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={{ padding: 12 }}>
        <Text style={{ color: tokens.foreground }}>{t("Visibility")}</Text>
      </Pressable>
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={{ flex: 1, padding: 20, gap: 12, backgroundColor: tokens.background }}>
          <View
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <Text accessibilityRole="header" style={{ color: tokens.foreground, fontSize: 18 }}>
              {t("Visibility")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              style={{ padding: 12 }}
            >
              <Text style={{ color: tokens.foreground }}>{t("Close")}</Text>
            </Pressable>
          </View>
          {error && (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {error}
            </Text>
          )}
          <TextInput
            accessibilityLabel={t("Search models")}
            placeholder={t("Search models")}
            placeholderTextColor={tokens.mutedForeground}
            value={query}
            onChangeText={setQuery}
            style={{
              padding: 12,
              color: tokens.foreground,
              borderColor: tokens.border,
              borderWidth: 1,
              borderRadius: 10,
            }}
          />
          <FlatList
            data={rows}
            keyExtractor={(row) => `${row.rule.provider}:${row.rule.model ?? ""}`}
            renderItem={({ item }) => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    color: tokens.foreground,
                    paddingLeft: item.rule.model ? 12 : 0,
                  }}
                >
                  {item.label}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(item.hidden ? "Unhide {name}" : "Hide {name}", {
                    name: item.label,
                  })}
                  disabled={busy || !visibility}
                  onPress={() => void change(item.rule, !item.hidden)}
                  style={{ padding: 12 }}
                >
                  <Text style={{ color: tokens.foreground }}>
                    {t(item.hidden ? "Unhide" : "Hide")}
                  </Text>
                </Pressable>
              </View>
            )}
          />
        </View>
      </Modal>
    </>
  );
}
