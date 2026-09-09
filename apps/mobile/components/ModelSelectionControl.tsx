import type {
  ModelCatalogEntry,
  ModelSelection,
  ModelSelectionStatus,
  ThinkingLevel,
} from "@rakazo/contracts";
import { modelOptionKey, parseModelOptionKey } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { modelIdentity, type PiModelSnapshot, searchPiModels } from "../lib/pi-models";

export function ModelSelectionControl({
  botId,
  worker,
  initial,
  onSaved,
  compact = false,
}: {
  botId: string;
  compact?: boolean;
  worker?: { threadId: string; participantId?: string };
  initial?: ModelSelection | null;
  onSaved?: (selection: ModelSelection | null) => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<(ModelCatalogEntry & { key: string; modelId: string })[]>(
    [],
  );
  const [key, setKey] = useState(initial ? modelOptionKey(initial.provider, initial.modelId) : "");
  const [thinking, setThinking] = useState<ThinkingLevel | "">(initial?.thinkingLevel ?? "");
  const [status, setStatus] = useState<ModelSelectionStatus>();
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<ModelSelection | null>(null);
  const [revision, setRevision] = useState(0);
  const forceRefresh = useRef(false);
  const selected = options.find((option) => option.key === key);
  const stale = parseModelOptionKey(key);
  const generation = useRef(0);
  const saving = useRef(false);
  const dirtyRevision = useRef(0);
  function close() {
    generation.current++;
    saving.current = false;
    setBusy(false);
    setOpen(false);
  }
  useEffect(() => {
    generation.current++;
    saving.current = false;
    dirtyRevision.current = 0;
    setBusy(false);
    const model = worker ? null : initial;
    setKey(model ? modelOptionKey(model.provider, model.modelId) : "");
    setThinking(model?.thinkingLevel ?? "");
    return () => {
      generation.current++;
      saving.current = false;
    };
  }, [open, botId, worker?.threadId, worker?.participantId]);
  useEffect(() => {
    setOptions([]);
    setCurrent(null);
    setStatus(undefined);
    setError(undefined);
    setReady(false);
    setQuery("");
  }, [botId, worker?.threadId, worker?.participantId]);
  useEffect(() => {
    if (!open && !compact) return;
    let cancelled = false;
    setReady(false);
    let loading = false;
    const load = async () => {
      if (loading || saving.current) return;
      loading = true;
      const request = generation.current;
      try {
        const force = forceRefresh.current;
        forceRefresh.current = false;
        const next = await rpc<PiModelSnapshot>("models/runtime", {
          botId,
          ...worker,
          ...(force ? { refresh: true } : {}),
        });
        if (cancelled || request !== generation.current || saving.current) return;
        const available = next.availability.status === "available";
        if (available)
          setOptions(
            next.catalog.map((entry) => ({
              ...entry,
              key: modelOptionKey(entry.provider, entry.id),
              modelId: entry.id,
            })),
          );
        if (available || next.current) setCurrent(next.current);
        if (available || next.selection) {
          setStatus(next.selection ?? undefined);
          if (worker && !dirtyRevision.current) {
            const model = next.selection?.requested;
            setKey(model ? modelOptionKey(model.provider, model.modelId) : "");
            setThinking(model?.thinkingLevel ?? "");
          }
        }
        setReady(available);
        setError(available ? undefined : next.availability.error || t("Unavailable"));
      } catch (cause) {
        if (!cancelled && request === generation.current && !saving.current) {
          setReady(false);
          setError(String(cause));
        }
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = status?.status === "pending" ? setInterval(() => void load(), 2000) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [open, compact, botId, worker?.threadId, worker?.participantId, revision, status?.status]);
  async function save(reset = false) {
    if (
      busy ||
      saving.current ||
      !open ||
      !ready ||
      (!reset &&
        ((!selected && Boolean(worker || key)) ||
          (thinking && !selected?.thinkingLevels?.includes(thinking))))
    )
      return;
    const selection: ModelSelection | null =
      !reset && selected
        ? {
            provider: selected.provider,
            modelId: selected.modelId,
            thinkingLevel: thinking || null,
          }
        : null;
    const request = ++generation.current;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (worker) {
        const next = await rpc<ModelSelectionStatus>("models/setWorkerSelection", {
          botId,
          ...worker,
          selection,
        });
        if (request !== generation.current) return;
        dirtyRevision.current = 0;
        setStatus(next);
        setRevision((value) => value + 1);
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
        if (request !== generation.current) return;
        dirtyRevision.current = 0;
        onSaved?.(selection);
        close();
      }
    } catch (cause) {
      if (request === generation.current) setError(String(cause));
    } finally {
      if (request === generation.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Model")}
        onPress={() => setOpen(true)}
        style={[
          styles.button,
          compact && { maxWidth: 120, minHeight: 44, justifyContent: "center" },
        ]}
      >
        <Text numberOfLines={1} style={{ color: tokens.foreground }}>
          {compact
            ? current?.modelId || initial?.modelId || t("Model")
            : `${t("Model")}${initial ? ` · ${initial.modelId}` : ""}`}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={close}
      >
        <View style={[styles.sheet, { backgroundColor: tokens.background }]}>
          <View style={styles.header}>
            <Text
              accessibilityRole="header"
              style={{ color: tokens.foreground, fontSize: 18, flex: 1 }}
            >
              {t("Model")}
            </Text>
            <Pressable accessibilityRole="button" onPress={close} style={styles.button}>
              <Text style={{ color: tokens.foreground }}>{t("Close")}</Text>
            </Pressable>
          </View>
          {(error || status?.error) && (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {error || status?.error}
            </Text>
          )}
          <Text style={{ color: tokens.mutedForeground }}>
            {t("Current")}: {modelIdentity(current) || t("Unavailable")}
          </Text>
          {status ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Requested")}:{" "}
              {modelIdentity(status.requested) ||
                t(worker?.participantId ? "Bot model" : "Pi selection")}{" "}
              ·{" "}
              {t(
                status.status === "pending"
                  ? "Pending"
                  : status.status === "failed"
                    ? "Failed"
                    : "Applied",
              )}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              forceRefresh.current = true;
              setRevision((value) => value + 1);
            }}
            style={styles.button}
          >
            <Text style={{ color: tokens.foreground }}>{t("Refresh")}</Text>
          </Pressable>
          <TextInput
            accessibilityLabel={t("Search models")}
            placeholder={t("Search models")}
            placeholderTextColor={tokens.mutedForeground}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ color: tokens.foreground, padding: 12 }}
          />
          {thinking && !selected?.thinkingLevels?.includes(thinking) ? (
            <Text style={{ color: tokens.mutedForeground }}>
              {t("Thinking")}: {thinking} · {t("Unavailable")}
            </Text>
          ) : null}
          <FlatList
            data={[
              ...(!worker ? [{ key: "", label: t("Pi selection") }] : []),
              ...(key && !selected
                ? [
                    {
                      key,
                      label: `${stale ? `${stale.provider}/${stale.modelId}` : key} · ${t("Unavailable")}`,
                    },
                  ]
                : []),
              ...searchPiModels(options, query).map((entry) => ({
                key: modelOptionKey(entry.provider, entry.id),
                label: `${entry.label} · ${entry.provider}/${entry.id}`,
              })),
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
                  dirtyRevision.current++;
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
          {selected?.thinkingLevels?.length ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: tokens.mutedForeground }}>{t("Thinking")}</Text>
              <ScrollView horizontal style={{ flexGrow: 0 }}>
                {["", ...selected.thinkingLevels].map((level) => (
                  <Pressable
                    key={level}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: level === thinking }}
                    disabled={busy}
                    onPress={() => {
                      dirtyRevision.current++;
                      setThinking(level as ThinkingLevel | "");
                    }}
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
            disabled={
              busy ||
              !ready ||
              (!selected && Boolean(worker || key)) ||
              Boolean(thinking && !selected?.thinkingLevels?.includes(thinking))
            }
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
              <Text style={{ color: tokens.foreground }}>
                {t(worker?.participantId ? "Use bot model" : "Use Pi selection")}
              </Text>
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
