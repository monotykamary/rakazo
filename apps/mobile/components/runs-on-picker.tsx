import type { MachineAssignment } from "@rakazo/contracts";
import {
  BotDeploymentController,
  currentMachine,
  isLocalManagedOrigin,
  type MachineGateway,
  type MachineSummary,
  machinePairingCommand,
  orderedMachineChoices,
} from "@rakazo/core";
import * as ExpoClipboard from "expo-clipboard";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

const gateway: MachineGateway = {
  list: () => rpc<MachineSummary[]>("machines/list", {}),
  startPairing: (name) => rpc("machines/startPairing", { name }),
  cancelPairing: async (pairingId) => {
    await rpc("machines/cancelPairing", { pairingId });
  },
  revoke: async (machineId) => {
    await rpc("machines/revoke", { machineId });
  },
  assignment: async (botId) =>
    (await rpc<MachineAssignment>("machines/assignment", { botId })).machineId,
  assign: async (botId, machineId) => {
    await rpc("machines/assign", { botId, machineId });
  },
};

export function RunsOnPicker({
  botId,
  apiBase,
  onMachineChange,
  disabled = false,
}: {
  botId: string;
  apiBase: string | undefined;
  onMachineChange?: (machineId: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(() => createRunsOnStyles(tokens));
  const controller = useMemo(() => new BotDeploymentController(gateway, botId), [botId]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (snapshot.phase === "ready") onMachineChange?.(snapshot.botMachineId);
  }, [snapshot.phase, snapshot.botMachineId, onMachineChange]);

  const current = currentMachine(snapshot.botMachineId, snapshot.machines);
  const pairing = snapshot.pairing;

  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.label}>{t("Runs on")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: false }}
        disabled={disabled}
        accessibilityLabel={t("Runs on")}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          pressed && styles.pressed,
          disabled && styles.disabled,
        ]}
      >
        <Text style={styles.triggerLabel} numberOfLines={1}>
          {current
            ? current.name
            : snapshot.botMachineId
              ? t("Unavailable machine")
              : t("Default machine")}
        </Text>
        <NativeSymbol
          ios="chevron.right"
          android="chevron-forward"
          size={14}
          color={native.secondaryLabel}
        />
      </Pressable>
      {snapshot.error ? <Text style={styles.error}>{snapshot.error}</Text> : null}
      <Modal
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={() => setOpen(false)}
        visible={open}
      >
        <ScrollView contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
          <Text style={styles.title} numberOfLines={1}>
            {t("Runs on")}
          </Text>
          {isLocalManagedOrigin(apiBase) ? (
            <Text style={styles.note} testID="runs-on-local-warning">
              {t("Paired machines pause while this computer sleeps.")}
            </Text>
          ) : null}
          {pairing ? (
            <PairingPanel controller={controller} pairing={pairing} serverOrigin={apiBase ?? ""} />
          ) : (
            <MachineList controller={controller} snapshot={snapshot} current={current} />
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          >
            <Text style={styles.cancelLabel}>{t("Cancel")}</Text>
          </Pressable>
        </ScrollView>
      </Modal>
    </View>
  );
}

type Snapshot = ReturnType<BotDeploymentController["getSnapshot"]>;

function MachineList({
  controller,
  snapshot,
  current,
}: {
  controller: BotDeploymentController;
  snapshot: Snapshot;
  current: MachineSummary | null;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(() => createRunsOnStyles(tokens));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const choices = orderedMachineChoices(snapshot.machines);

  function confirmRevoke(machine: MachineSummary) {
    Alert.alert(t("Revoke {name}?", { name: machine.name }), t("The machine loses access."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Revoke"),
        style: "destructive",
        onPress: () => void controller.revoke(machine.id),
      },
    ]);
  }

  return (
    <View>
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected: snapshot.botMachineId === null }}
        disabled={snapshot.saving}
        onPress={() => void controller.choose(null)}
        style={({ pressed }) => [styles.machine, pressed && styles.pressed]}
      >
        <Text style={styles.machineLabel}>{t("Default machine")}</Text>
        {snapshot.botMachineId === null ? (
          <NativeSymbol ios="checkmark" android="checkmark" size={16} color={native.label} />
        ) : null}
      </Pressable>
      {choices.map((machine) => (
        <View key={machine.id} style={styles.machineRow}>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: current?.id === machine.id }}
            disabled={snapshot.saving}
            onPress={() => void controller.choose(machine.id)}
            style={({ pressed }) => [styles.machine, pressed && styles.pressed]}
          >
            <View
              style={[
                styles.dot,
                {
                  backgroundColor:
                    machine.status === "online" ? tokens.success : tokens.mutedForeground,
                },
              ]}
            />
            <Text style={styles.machineLabel} numberOfLines={1}>
              {machine.name}
            </Text>
            {current?.id === machine.id ? (
              <NativeSymbol ios="checkmark" android="checkmark" size={16} color={native.label} />
            ) : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Revoke {name}", { name: machine.name })}
            disabled={snapshot.saving}
            onPress={() => confirmRevoke(machine)}
            hitSlop={8}
            style={styles.revoke}
          >
            <Text style={styles.revokeLabel}>{t("Revoke")}</Text>
          </Pressable>
        </View>
      ))}
      {adding ? (
        <View style={styles.addRow}>
          <TextInput
            autoFocus
            value={name}
            maxLength={60}
            onChangeText={setName}
            placeholder={t("Machine name")}
            accessibilityLabel={t("Machine name")}
            placeholderTextColor={native.secondaryLabel}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Pair machine")}
            disabled={!name.trim() || snapshot.saving}
            onPress={() => void controller.startPairing(name.trim())}
            style={[styles.pairButton, (!name.trim() || snapshot.saving) && styles.disabled]}
          >
            <Text style={styles.pairLabel}>{t("Pair")}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Add machine")}
          onPress={() => setAdding(true)}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <NativeSymbol ios="plus" android="add" size={17} color={native.label} />
          <Text style={styles.actionLabel}>{t("Add machine")}</Text>
        </Pressable>
      )}
      {snapshot.error ? <Text style={styles.error}>{snapshot.error}</Text> : null}
    </View>
  );
}

function PairingPanel({
  controller,
  pairing,
  serverOrigin,
}: {
  controller: BotDeploymentController;
  pairing: NonNullable<Snapshot["pairing"]>;
  serverOrigin: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(() => createRunsOnStyles(tokens));
  const command = serverOrigin ? machinePairingCommand(serverOrigin, pairing.code) : "";
  if (pairing.phase === "paired") {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => controller.acknowledgePairing()}
        style={styles.action}
      >
        <Text style={styles.actionLabel}>{t("Choose machine")}</Text>
      </Pressable>
    );
  }
  return (
    <View>
      <View style={styles.codeRow} testID="runs-on-pairing-code">
        <Text style={styles.code} selectable>
          {command}
        </Text>
        <Pressable
          disabled={!command}
          accessibilityRole="button"
          accessibilityLabel={t("Copy pairing command")}
          hitSlop={8}
          onPress={() => void ExpoClipboard.setStringAsync(command)}
          style={styles.revoke}
        >
          <Text style={styles.revokeLabel}>{t("Copy")}</Text>
        </Pressable>
      </View>
      {pairing.phase === "waiting" ? (
        <Text style={styles.note}>{t("Waiting for machine…")}</Text>
      ) : null}
      {pairing.phase === "expired" ? (
        <Text style={styles.error}>{t("Pairing expired.")}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={
          pairing.phase === "expired"
            ? () => controller.acknowledgePairing()
            : () => void controller.cancelPairing()
        }
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <Text style={styles.actionLabel}>
          {pairing.phase === "expired" ? t("Done") : t("Cancel pairing")}
        </Text>
      </Pressable>
    </View>
  );
}

function createRunsOnStyles(tokens: ReturnType<typeof useMobileTokens>) {
  return StyleSheet.create({
    label: {
      color: native.secondaryLabel,
      fontSize: 14,
      marginBottom: 8,
    },
    trigger: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 11,
      paddingHorizontal: 14,
    },
    triggerLabel: {
      color: native.label,
      fontSize: 16,
      flex: 1,
    },
    sheet: {
      flexGrow: 1,
      backgroundColor: tokens.background,
      paddingHorizontal: 16,
      paddingTop: 18,
      paddingBottom: 28,
    },
    title: {
      color: native.label,
      fontSize: 18,
      fontWeight: "600",
      paddingHorizontal: 8,
      paddingBottom: 10,
    },
    note: {
      color: native.secondaryLabel,
      fontSize: 13,
      paddingHorizontal: 10,
      paddingBottom: 8,
    },
    machineRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    machine: {
      flex: 1,
      minHeight: 46,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: 11,
      paddingHorizontal: 10,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    machineLabel: {
      flex: 1,
      color: native.label,
      fontSize: 16,
    },
    revoke: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    revokeLabel: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    action: {
      minHeight: 46,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: 11,
      paddingHorizontal: 10,
      marginTop: 6,
    },
    actionLabel: {
      color: native.label,
      fontSize: 16,
      flex: 1,
    },
    addRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 8,
      paddingVertical: 6,
      marginTop: 6,
    },
    input: {
      flex: 1,
      height: 40,
      borderRadius: 10,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 12,
      fontSize: 16,
    },
    pairButton: {
      minHeight: 40,
      justifyContent: "center",
      borderRadius: 10,
      backgroundColor: native.label,
      paddingHorizontal: 14,
    },
    pairLabel: {
      color: native.page,
      fontSize: 14,
      fontWeight: "600",
    },
    codeRow: {
      borderRadius: 11,
      backgroundColor: native.fill,
      paddingHorizontal: 12,
      paddingVertical: 12,
      marginHorizontal: 8,
      marginBottom: 6,
    },
    code: {
      color: native.label,
      fontSize: 16,
    },
    error: {
      color: tokens.destructive,
      fontSize: 13,
      paddingHorizontal: 10,
      paddingTop: 8,
    },
    pressed: {
      backgroundColor: native.fill,
      opacity: 0.7,
    },
    disabled: {
      opacity: 0.4,
    },
    cancel: {
      alignItems: "center",
      paddingTop: 14,
      paddingBottom: 2,
    },
    cancelLabel: {
      color: native.secondaryLabel,
      fontSize: 16,
      fontWeight: "600",
    },
  });
}
