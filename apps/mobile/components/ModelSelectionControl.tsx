import type {
  ModelCatalogEntry,
  ModelCredential,
  ModelSelection,
  ModelSelectionStatus,
  ModelVisibility,
  ThinkingLevel,
} from "@rakazo/contracts";
import { isModelHidden } from "@rakazo/contracts";
import { connectedModelOptions, modelOptionKey } from "@rakazo/core";
import { useEffect, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";

export function ModelSelectionControl({
  botId,
  worker,
  initial,
  onSaved,
}: {
  botId: string;
  worker?: { threadId: string; participantId: string };
  initial?: ModelSelection | null;
  onSaved?: (selection: ModelSelection | null) => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ReturnType<typeof connectedModelOptions>>([]);
  const [key, setKey] = useState(initial ? modelOptionKey(initial.provider, initial.modelId) : "");
  const [thinking, setThinking] = useState<ThinkingLevel | "">(initial?.thinkingLevel ?? "");
  const [status, setStatus] = useState<ModelSelectionStatus>();
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const selected = options.find((option) => option.key === key);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReady(false);
    setError(undefined);
    void Promise.all([
      rpc<ModelCredential[]>("models/credentials", {}),
      rpc<ModelCatalogEntry[]>("models/list", {}),
      worker
        ? rpc<ModelSelectionStatus>("models/getSelection", { botId, ...worker })
        : Promise.resolve(undefined),
      rpc<ModelVisibility>("models/getVisibility", {}),
    ])
      .then(([credentials, catalog, state, visibility]) => {
        if (cancelled) return;
        setOptions(
          connectedModelOptions(credentials, catalog).filter(
            (option) => !isModelHidden(visibility, option.provider, option.modelId),
          ),
        );
        setStatus(state);
        setReady(true);
        const model = state ? state.requested : initial;
        setKey(model ? modelOptionKey(model.provider, model.modelId) : "");
        setThinking(model?.thinkingLevel ?? "");
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, botId, worker?.threadId, worker?.participantId]);
  useEffect(() => {
    if (!open || !worker || status?.status !== "pending") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void rpc<ModelSelectionStatus>("models/getSelection", { botId, ...worker })
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch((cause) => {
          if (!cancelled) setError(String(cause));
        });
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, botId, worker?.threadId, worker?.participantId, status?.status]);
  async function save(reset = false) {
    if (busy || !ready || (!reset && !selected && Boolean(worker || key))) return;
    const selection: ModelSelection | null =
      !reset && selected
        ? {
            provider: selected.provider,
            modelId: selected.modelId,
            thinkingLevel: thinking || null,
          }
        : null;
    setBusy(true);
    setError(undefined);
    try {
      if (worker) {
        const next = await rpc<ModelSelectionStatus>("models/setWorkerSelection", {
          botId,
          ...worker,
          selection,
        });
        setStatus(next);
        setKey(
          next.requested ? modelOptionKey(next.requested.provider, next.requested.modelId) : "",
        );
        setThinking(next.requested?.thinkingLevel ?? "");
      } else {
        await rpc("bots/update", {
          botId,
          modelProvider: selection?.provider ?? null,
          modelId: selection?.modelId ?? null,
          thinkingLevel: selection?.thinkingLevel ?? null,
        });
        onSaved?.(selection);
        setOpen(false);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={styles.button}>
        <Text style={{ color: tokens.foreground }}>
          {t("Model")}
          {initial ? ` · ${initial.modelId}` : ""}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={[styles.sheet, { backgroundColor: tokens.background }]}>
          <View style={styles.header}>
            <Text
              accessibilityRole="header"
              style={{ color: tokens.foreground, fontSize: 18, flex: 1 }}
            >
              {t("Model")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              style={styles.button}
            >
              <Text style={{ color: tokens.foreground }}>{t("Close")}</Text>
            </Pressable>
          </View>
          {(error || status?.error) && (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {error || status?.error}
            </Text>
          )}
          {status &&
            status.status !== "applied" &&
            (status.status === "pending" || status.effective) && (
              <Text style={{ color: tokens.mutedForeground }}>
                {status.status === "pending" ? t("Pending") : ""}
                {status.effective
                  ? `${status.status === "pending" ? " · " : ""}${t("Effective")}: ${status.effective.modelId}`
                  : ""}
              </Text>
            )}
          <FlatList
            data={[
              ...(!worker ? [{ key: "", label: t("Account default") }] : []),
              ...(key && !selected
                ? [
                    {
                      key,
                      label: `${status?.requested?.modelId ?? initial?.modelId ?? key} · ${t("Unavailable")}`,
                    },
                  ]
                : []),
              ...options,
            ]}
            keyExtractor={(item) => item.key}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{
                  checked: item.key === key,
                  disabled:
                    busy || Boolean(item.key && !options.some((option) => option.key === item.key)),
                }}
                disabled={
                  busy || Boolean(item.key && !options.some((option) => option.key === item.key))
                }
                onPress={() => {
                  setKey(item.key);
                  setThinking("");
                }}
                style={[
                  styles.option,
                  { backgroundColor: item.key === key ? tokens.muted : tokens.background },
                ]}
              >
                <Text style={{ color: tokens.foreground }}>{item.label}</Text>
              </Pressable>
            )}
          />
          {selected?.thinkingLevels.length ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: tokens.mutedForeground }}>{t("Thinking")}</Text>
              <ScrollView horizontal style={{ flexGrow: 0 }}>
                {["", ...selected.thinkingLevels].map((level) => (
                  <Pressable
                    key={level}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: level === thinking }}
                    disabled={busy}
                    onPress={() => setThinking(level as ThinkingLevel | "")}
                    style={[
                      styles.button,
                      { backgroundColor: level === thinking ? tokens.muted : tokens.background },
                    ]}
                  >
                    <Text style={{ color: tokens.foreground }}>{level || t("Default")}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy || !ready || (!selected && Boolean(worker || key))}
            onPress={() => void save()}
            style={styles.button}
          >
            <Text style={{ color: tokens.foreground }}>{t("Save")}</Text>
          </Pressable>
          {worker && (
            <Pressable
              accessibilityRole="button"
              disabled={busy || !ready}
              onPress={() => void save(true)}
              style={styles.button}
            >
              <Text style={{ color: tokens.foreground }}>{t("Use bot model")}</Text>
            </Pressable>
          )}
        </View>
      </Modal>
    </>
  );
}
const styles = StyleSheet.create({
  sheet: { flex: 1, padding: 20, gap: 12 },
  header: { flexDirection: "row", alignItems: "center" },
  button: { padding: 12 },
  option: { padding: 16, borderRadius: 10 },
});
