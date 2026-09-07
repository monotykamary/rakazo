import {
  type ModelCatalogEntry,
  type ModelCredential,
  type ModelRouting,
  ModelRoutingSchema,
} from "@rakazo/contracts";
import { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

type Props = {
  credential: ModelCredential;
  credentials: ModelCredential[];
  modelId: string;
  catalog: ModelCatalogEntry[];
};
export function ModelRoutingSettings(props: Props) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={styles.button}
      >
        <Text style={{ color: tokens.foreground }}>{t("Rotation and fallback")}</Text>
      </Pressable>
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={[styles.sheet, { backgroundColor: tokens.background }]}>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => setOpen(false)}
          >
            <Text style={{ color: tokens.foreground }}>{t("Close")}</Text>
          </Pressable>
          {open && <RoutingForm key={props.credential.id} {...props} />}
        </View>
      </Modal>
    </>
  );
}
function RoutingForm({ credential, credentials, modelId, catalog }: Props) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const initial = (): ModelRouting => ({
    version: 1,
    strategy: "ordered",
    credentialIds: [credential.id],
    modelId,
    fallbacks: [],
  });
  const [routing, setRouting] = useState<ModelRouting>(initial);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [fallbackCredential, setFallbackCredential] = useState(credential.id);
  const [fallbackModel, setFallbackModel] = useState("");
  const [choosingConnection, setChoosingConnection] = useState(false);
  const [choosingModel, setChoosingModel] = useState(false);
  const foreground = { color: tokens.foreground };
  useEffect(() => {
    let alive = true;
    rpc("models/getRouting", { credentialId: credential.id })
      .then((value) => {
        if (alive) {
          setRouting(ModelRoutingSchema.nullable().parse(value) ?? initial());
          setLoaded(true);
        }
      })
      .catch((cause) => {
        if (alive) setError(String(cause));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [credential.id]);
  function change(next: ModelRouting) {
    setRouting(next);
    setDirty(true);
  }
  async function save(value: ModelRouting | null) {
    if (busy || !loaded) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await rpc("models/setRouting", {
        credentialId: credential.id,
        routing: value === null ? null : ModelRoutingSchema.parse(value),
      });
      setRouting(ModelRoutingSchema.nullable().parse(result) ?? initial());
      setDirty(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  function button(label: string, onPress: () => void, disabled = false) {
    return (
      <Pressable
        accessibilityRole="button"
        disabled={busy || !loaded || disabled}
        onPress={onPress}
        style={[styles.button, { opacity: busy || !loaded || disabled ? 0.4 : 1 }]}
      >
        <Text style={foreground}>{label}</Text>
      </Pressable>
    );
  }
  const fallbackProvider = credentials.find((item) => item.id === fallbackCredential)?.provider;
  return (
    <ScrollView keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={foreground}>
        {t("Rotation and fallback")}
      </Text>
      {error && (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      )}
      <TextInput
        accessibilityLabel={t("Pool model")}
        value={routing.modelId}
        editable={!busy && loaded}
        onChangeText={(value) => change({ ...routing, modelId: value })}
        style={[styles.input, foreground, { borderColor: tokens.border }]}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.row}>
        <Text style={foreground}>{t("Round robin")}</Text>
        <Switch
          accessibilityLabel={t("Round robin")}
          disabled={busy || !loaded}
          value={routing.strategy === "round-robin"}
          onValueChange={(checked) =>
            change({ ...routing, strategy: checked ? "round-robin" : "ordered" })
          }
        />
      </View>
      {credentials
        .filter((item) => item.provider === credential.provider)
        .map((item) => (
          <View key={item.id} style={styles.row}>
            <Text style={foreground}>{item.label}</Text>
            <Switch
              accessibilityLabel={item.label}
              disabled={busy || !loaded || item.id === credential.id}
              value={routing.credentialIds.includes(item.id)}
              onValueChange={(checked) =>
                change({
                  ...routing,
                  credentialIds: checked
                    ? [...routing.credentialIds, item.id]
                    : routing.credentialIds.filter((id) => id !== item.id),
                })
              }
            />
          </View>
        ))}
      {routing.fallbacks.map((target, index) => (
        <View key={`${target.credentialId}:${target.modelId}`}>
          <Text style={foreground}>
            {credentials.find((item) => item.id === target.credentialId)?.label ??
              target.credentialId}{" "}
            · {target.modelId}
          </Text>
          <View style={styles.row}>
            {button(
              t("Move up"),
              () => {
                const next = [...routing.fallbacks];
                [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                change({ ...routing, fallbacks: next });
              },
              index === 0,
            )}
            {button(t("Remove"), () =>
              change({ ...routing, fallbacks: routing.fallbacks.filter((_, i) => i !== index) }),
            )}
          </View>
        </View>
      ))}
      {button(t("Fallback connection"), () => setChoosingConnection(!choosingConnection))}
      <Text style={foreground}>
        {credentials.find((item) => item.id === fallbackCredential)?.label}
      </Text>
      {choosingConnection &&
        credentials.map((item) => (
          <View key={item.id}>
            {button(item.label, () => {
              setFallbackCredential(item.id);
              setFallbackModel("");
              setChoosingConnection(false);
            })}
          </View>
        ))}
      <TextInput
        accessibilityLabel={t("Fallback model")}
        value={fallbackModel}
        editable={!busy && loaded}
        onChangeText={setFallbackModel}
        style={[styles.input, foreground, { borderColor: tokens.border }]}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {button(t("Choose model"), () => setChoosingModel(!choosingModel))}
      {choosingModel &&
        catalog
          .filter((item) => item.provider === fallbackProvider)
          .map((item) => (
            <View key={item.id}>
              {button(item.label, () => {
                setFallbackModel(item.id);
                setChoosingModel(false);
              })}
            </View>
          ))}
      {button(
        t("Add fallback"),
        () => {
          change({
            ...routing,
            fallbacks: [
              ...routing.fallbacks,
              { credentialId: fallbackCredential, modelId: fallbackModel.trim() },
            ],
          });
          setFallbackModel("");
        },
        !fallbackModel.trim(),
      )}
      <View style={styles.row}>
        {button(t("Save"), () => void save(routing), !dirty)}
        {button(t("Reset"), () => void save(null))}
      </View>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  sheet: { flex: 1, padding: 16, paddingTop: 28 },
  button: { minHeight: 44, padding: 12 },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingVertical: 8,
  },
  input: { borderWidth: 1, borderRadius: 8, padding: 12, marginVertical: 8 },
});
