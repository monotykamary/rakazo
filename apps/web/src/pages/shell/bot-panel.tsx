import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  ComputerMode,
  ThinkingLevel,
  VoiceInfo,
} from "@rakazo/contracts";
import {
  BOT_COLORS,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import { type BotPromptHandler, modelOptionKey, parseModelOptionKey } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { BotRunsOn } from "../../components/BotRunsOn";
import { BotServices } from "../../components/BotServices";
import { PiModelPicker, PiModelStatus } from "../../components/PiModelPicker";
import { rpc } from "../../lib/rpc";

const ScratchpadSection = lazy(() =>
  import("../ScratchpadSection").then((module) => ({ default: module.ScratchpadSection })),
);

const KnowledgeSection = lazy(() =>
  import("../KnowledgeSection").then((module) => ({ default: module.KnowledgeSection })),
);

const fieldLabelClass = "mt-4 block text-[14px] text-muted-foreground";

function ComputerModePicker({
  value,
  onChange,
  teamTestId,
  privateTestId,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
  teamTestId?: string;
  privateTestId?: string;
}) {
  return (
    <div className="mt-4">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Computer</Trans>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["team", "dedicated"] as const).map((mode) => (
          <Toggle
            key={mode}
            variant="outline"
            pressed={value === mode}
            data-testid={mode === "team" ? teamTestId : privateTestId}
            onPressedChange={(pressed) => {
              if (pressed) onChange(mode);
            }}
            className="capitalize aria-pressed:border-foreground/40 aria-pressed:text-foreground"
          >
            {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

export function CreateBotForm({
  onCreate,
  onCancel,
}: {
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        computerMode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not create bot`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="create-bot-form">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>New bot</Trans>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label={t`Cancel new bot`} onClick={onCancel}>
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          data-testid="create-bot-error"
          className="mb-3 text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : null}
      <label htmlFor={`${ids}-name`} className="mt-6 block text-[14px] text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this bot`}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t`Describe what this bot does`}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t`What this bot is for`}
          rows={4}
          className="mt-2"
        />
      </label>
      <div data-testid="create-bot-computer">
        <ComputerModePicker
          value={computerMode}
          onChange={setComputerMode}
          teamTestId="create-bot-team"
          privateTestId="create-bot-private"
        />
      </div>
      <Button
        className="mt-5"
        disabled={!name.trim() || submitting}
        onClick={() => void handleSubmit()}
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
      </Button>
    </div>
  );
}

export function BotSettings({
  bot,
  memoryProviderConfigured,
  onSkillsChange,
  onSave,
  onExport,
  onClear,
  onPrompt,
  sending = false,
}: {
  bot: Bot;
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
    color?: string;
    computerMode: ComputerMode;
    memoryScope?: "isolated" | "shared" | null;
    autoSpeak?: boolean;
    voiceId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
  onPrompt: BotPromptHandler;
  sending?: boolean;
}) {
  const { t } = useLingui();
  const [advancedOpened, setAdvancedOpened] = useState(false);
  const ids = useId();
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [color, setColor] = useState(bot.color);
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [machineAssigned, setMachineAssigned] = useState(false);
  const onMachineChange = useCallback(
    (machineId: string | null) => {
      if (machineId !== null || machineAssigned) setComputerMode("dedicated");
      setMachineAssigned(machineId !== null);
    },
    [machineAssigned],
  );
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof rpc.models.runtime>>>();
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [modelEdited, setModelEdited] = useState(false);
  const modelRevision = useRef(0);
  const modelScope = useRef<string | undefined>(bot.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function refreshModels(force = false) {
    if (modelScope.current !== bot.id) return;
    const revision = ++modelRevision.current;
    setModelLoading(true);
    setModelError(false);
    try {
      const next = await rpc.models.runtime({ botId: bot.id, ...(force ? { refresh: true } : {}) });
      if (revision === modelRevision.current) setRuntime(next);
    } catch {
      if (revision === modelRevision.current) setModelError(true);
    } finally {
      if (revision === modelRevision.current) setModelLoading(false);
    }
  }
  useEffect(() => {
    modelScope.current = bot.id;
    setRuntime(undefined);
    setModelEdited(false);
    setModelKey(
      bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
    );
    setThinkingLevel(bot.thinkingLevel ?? "");
    setSaving(false);
    let cancelled = false;
    void rpc.voice
      .voices({})
      .then((next) => {
        if (!cancelled) setVoices(next);
      })
      .catch(() => undefined);
    void refreshModels();
    return () => {
      cancelled = true;
      modelScope.current = undefined;
      modelRevision.current += 1;
    };
  }, [bot.id]);
  useEffect(() => {
    if (runtime?.selection?.status !== "pending" || saving || modelLoading) return;
    const timer = setTimeout(() => void refreshModels(), 2000);
    return () => clearTimeout(timer);
  }, [runtime, saving, modelLoading]);
  const draft = parseModelOptionKey(modelKey);
  const selectedModel = draft
    ? { ...draft, thinkingLevel: (thinkingLevel || null) as ThinkingLevel | null }
    : null;
  const selectedAvailable =
    !draft ||
    runtime?.catalog.some(
      (entry) =>
        entry.provider === draft.provider &&
        entry.id === draft.modelId &&
        (!thinkingLevel || entry.thinkingLevels?.includes(thinkingLevel as ThinkingLevel)),
    );

  return (
    <div data-testid="bot-settings">
      <div className="flex justify-center">
        <BotAvatar color={color} identity={bot.id} size={64} status={bot.status} />
      </div>
      <label htmlFor={`${ids}-name`} className="mt-6 block text-[14px] text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="mt-2"
        />
      </label>
      <div className={fieldLabelClass}>
        <Trans>Color</Trans>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={t`Color`}>
          {BOT_COLORS.map((option, index) => (
            <input
              key={option}
              className={`size-8 cursor-pointer appearance-none rounded-full border-2 ring-offset-card transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                color === option ? "border-foreground" : "border-transparent"
              }`}
              type="radio"
              name={`${ids}-color`}
              value={option}
              checked={color === option}
              aria-label={t`Color ${index + 1}`}
              style={{ backgroundColor: option }}
              onChange={() => setColor(option)}
            />
          ))}
        </div>
      </div>
      <BotRunsOn
        bot={bot}
        onMachineChange={onMachineChange}
        onPrompt={onPrompt}
        disabled={sending}
      />
      <details
        data-testid="bot-settings-advanced"
        className="group mt-5"
        onToggle={(event) => {
          if (event.currentTarget.open) setAdvancedOpened(true);
        }}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
          <span className="text-muted-foreground">
            <Trans>Advanced</Trans>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        {!machineAssigned ? (
          <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        ) : null}
        <BotServices botId={bot.id} />
        <Suspense fallback={null}>
          <ScratchpadSection botId={bot.id} />
          {advancedOpened ? (
            <KnowledgeSection botId={bot.id} onSkillsChange={onSkillsChange} />
          ) : null}
        </Suspense>
        <div className="mt-4 space-y-3">
          <PiModelStatus current={runtime?.current ?? null} status={runtime?.selection} />
          {modelError ? (
            <p role="alert" className="text-sm text-destructive">{t`Could not refresh models`}</p>
          ) : runtime?.availability.status === "unavailable" ? (
            <p role="alert" className="text-sm text-destructive">{t`Pi unavailable`}</p>
          ) : null}
          {runtime?.availability.status === "available" && !runtime.catalog.length && (
            <p className="text-sm text-muted-foreground">{t`No models available`}</p>
          )}
          <PiModelPicker
            catalog={runtime?.catalog ?? []}
            selection={selectedModel}
            disabled={saving || runtime?.availability.status !== "available"}
            onChange={(next) => {
              setModelKey(modelOptionKey(next.provider, next.modelId));
              setThinkingLevel(next.thinkingLevel ?? "");
              setModelEdited(true);
            }}
          />
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving || runtime?.availability.status !== "available"}
              onClick={() => {
                setModelKey("");
                setThinkingLevel("");
                setModelEdited(true);
              }}
            >{t`Use Pi selection`}</Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving || modelLoading}
              onClick={() => void refreshModels(true)}
            >
              {modelLoading ? t`Refreshing…` : t`Refresh`}
            </Button>
          </div>
        </div>
        {memoryProviderConfigured ? (
          <div className="mt-4 text-[14px] text-muted-foreground">
            <Trans>Memory scope</Trans>
            <div className="mt-2 flex gap-2">
              {(
                [
                  { value: null, label: t`Inherit default` },
                  { value: "isolated" as const, label: t`Isolated` },
                  { value: "shared" as const, label: t`Shared` },
                ] satisfies Array<{ value: "isolated" | "shared" | null; label: string }>
              ).map((option) => (
                <Toggle
                  key={option.label}
                  variant="outline"
                  size="sm"
                  pressed={memoryScope === option.value}
                  onPressedChange={(pressed) => {
                    if (pressed) setMemoryScope(option.value);
                  }}
                  className="flex-1 aria-pressed:border-foreground/40 aria-pressed:text-foreground"
                >
                  {option.label}
                </Toggle>
              ))}
            </div>
          </div>
        ) : null}
        <label
          htmlFor={`${ids}-auto-speak`}
          className="mt-5 flex cursor-pointer items-center gap-3 text-[14px] text-foreground/75"
        >
          <Switch
            id={`${ids}-auto-speak`}
            checked={autoSpeak}
            onCheckedChange={(checked) => setAutoSpeak(checked)}
          />
          <Trans>Read replies aloud</Trans>
        </label>
        {voices.length ? (
          <label htmlFor={`${ids}-voice`} className={fieldLabelClass}>
            <Trans>Voice</Trans>
            <NativeSelect
              id={`${ids}-voice`}
              className="mt-2 w-full"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
            >
              <NativeSelectOption value="">{t`Account default`}</NativeSelectOption>
              {voices.map((voice) => (
                <NativeSelectOption key={voice.id} value={voice.id}>
                  {voice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </details>
      {error ? <p className="mt-2 text-[13px] text-destructive">{error}</p> : null}
      <div className="mt-5 flex flex-col items-start gap-3">
        <Button
          disabled={
            saving ||
            (modelEdited &&
              (modelLoading || runtime?.availability.status !== "available" || !selectedAvailable))
          }
          onClick={() => {
            setSaving(true);
            setError(null);
            const selected = modelKey ? parseModelOptionKey(modelKey) : null;
            const nextName = name.trim();
            const nextTitle = title.trim();
            const nextDescription = description.trim();
            setName(nextName);
            setTitle(nextTitle);
            setDescription(nextDescription);
            void onSave({
              name: nextName,
              title: nextTitle,
              description: nextDescription,
              instructions: nextDescription,
              color,
              computerMode,
              memoryScope,
              autoSpeak,
              voiceId: voiceId || null,
              ...(modelEdited
                ? {
                    modelProvider: selected?.provider ?? null,
                    modelId: selected?.modelId ?? null,
                    thinkingLevel: (thinkingLevel || null) as ThinkingLevel | null,
                  }
                : {}),
            })
              .then(() => {
                if (modelScope.current !== bot.id) return;
                setModelEdited(false);
                void refreshModels();
              })
              .catch(() => {
                if (modelScope.current === bot.id) setError(t`Could not save`);
              })
              .finally(() => {
                if (modelScope.current === bot.id) setSaving(false);
              });
          }}
        >
          <Trans>Save</Trans>
        </Button>
        <Button variant="ghost" size="sm" className="-ms-2.5" onClick={() => void onExport()}>
          <Trans>Export</Trans>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2.5 text-destructive hover:text-destructive"
          onClick={onClear}
        >
          <Trans>Clear conversation</Trans>
        </Button>
      </div>
    </div>
  );
}
