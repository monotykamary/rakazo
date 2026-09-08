import {
  BOT_COLORS,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type Bot,
  type ComputerMode,
  type ModelSelection,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import type { BotPromptHandler } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { ModelSelectionControl } from "../components/ModelSelectionControl";
import { RunsOnPicker } from "../components/runs-on-picker";
import { currentApiBase, type MobileBot, rpc } from "../lib/api";
import { cancelFocusPrompt } from "../lib/focus-prompt";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

type BotSettingsRecord = MobileBot &
  Pick<Bot, "modelProvider" | "modelId" | "thinkingLevel"> & {
    description?: string;
  };

export default function BotSettingsScreen() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [bot, setBot] = useState<BotSettingsRecord | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(BOT_COLORS[0]);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [machineAssigned, setMachineAssigned] = useState(false);
  const onMachineChange = useCallback(
    (machineId: string | null) => {
      if (machineId !== null || machineAssigned) setComputerMode("dedicated");
      setMachineAssigned(machineId !== null);
    },
    [machineAssigned],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const promptPending = useRef(false);
  const onPrompt: BotPromptHandler = async (targetBotId, text) => {
    if (pending || promptPending.current) return;
    promptPending.current = true;
    setPending(true);
    setError(null);
    try {
      const clientNonce =
        globalThis.crypto?.randomUUID?.() ??
        `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      // Same durable send endpoint as the composer, without its draft or attachments.
      await rpc("threads/send", { botId: targetBotId, text, clientNonce });
      cancelFocusPrompt(targetBotId);
      router.dismissTo({
        pathname: "/thread",
        params: { botId: targetBotId, ...(bot?.id === targetBotId ? { name: bot.name } : {}) },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Failed to send message"));
    } finally {
      promptPending.current = false;
      setPending(false);
    }
  };

  useEffect(() => {
    if (!botId) return;
    void rpc<BotSettingsRecord>("bots/get", { botId })
      .then((next) => {
        setBot(next);
        setName(next.name);
        setTitle(next.title);
        setDescription(next.description ?? "");
        setColor(next.color);
        setComputerMode(next.computerMode);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("Could not load bot")));
  }, [botId]);

  async function save() {
    if (!botId || !bot || pending) return;
    setPending(true);
    setError(null);
    try {
      const profile = normalizeCreateBotProfile({ name, title, description });
      const input: {
        botId: string;
        name?: string;
        title?: string;
        description?: string;
        instructions?: string;
        color?: string;
      } = { botId };
      if (profile.name !== bot.name) input.name = profile.name;
      if (profile.title !== bot.title) input.title = profile.title;
      if (profile.description !== (bot.description ?? "")) {
        input.description = profile.description;
        // Keep instructions in sync with description (same as web BotSettings).
        input.instructions = profile.instructions;
      }
      if (color !== bot.color) input.color = color;
      if (computerMode !== bot.computerMode) {
        await rpc("bots/setComputer", { botId, mode: computerMode });
      }
      // Use key presence so clearing title/description to "" still persists.
      if (Object.keys(input).length > 1) {
        await rpc("bots/update", input);
      }
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save bot"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: t("Chat settings") }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {bot ? (
          <View style={{ alignItems: "center", marginBottom: 24 }}>
            <BotAvatar color={color} identity={bot.id} size={64} status={bot.status} />
          </View>
        ) : null}
        {bot && (
          <ModelSelectionControl
            botId={bot.id}
            initial={
              bot.modelProvider && bot.modelId
                ? {
                    provider: bot.modelProvider,
                    modelId: bot.modelId,
                    thinkingLevel: bot.thinkingLevel ?? null,
                  }
                : null
            }
            onSaved={(selection: ModelSelection | null) =>
              setBot({
                ...bot,
                modelProvider: selection?.provider ?? null,
                modelId: selection?.modelId ?? null,
                thinkingLevel: selection?.thinkingLevel ?? null,
              })
            }
          />
        )}
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder={t("Name this bot")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Title")}
        </Text>
        <TextInput
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={setTitle}
          placeholder={t("Describe what this bot does")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Description")}
        </Text>
        <TextInput
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this bot is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
            minHeight: 120,
            textAlignVertical: "top",
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Color")}
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, marginTop: 8 }}
          accessibilityRole="radiogroup"
        >
          {BOT_COLORS.map((option, index) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={t("Color {number}", { number: index + 1 })}
              accessibilityState={{ checked: color === option }}
              onPress={() => setColor(option)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: option,
                borderWidth: 3,
                borderColor: color === option ? tokens.foreground : "transparent",
              }}
            />
          ))}
        </ScrollView>
        {!machineAssigned ? (
          <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        ) : null}
        {bot ? (
          <RunsOnPicker
            botId={bot.id}
            apiBase={currentApiBase()}
            onMachineChange={onMachineChange}
            onPrompt={onPrompt}
            disabled={pending}
          />
        ) : null}
        {bot ? (
          <Pressable
            onPress={() => router.push(`/bot-services?botId=${bot.id}`)}
            accessibilityRole="button"
            accessibilityLabel={t("Services")}
          >
            <Text style={{ color: tokens.primary, fontSize: 15, marginTop: 12 }}>
              {t("Services")}
            </Text>
          </Pressable>
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void save()}
          disabled={!name.trim() || pending || !bot}
          style={{
            marginTop: 24,
            backgroundColor: tokens.primary,
            borderRadius: 11,
            padding: 16,
            alignItems: "center",
            opacity: !name.trim() || pending || !bot ? 0.4 : 1,
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16 }}>
            {pending ? t("Saving…") : t("Save")}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
