import type { OutgoingMessageDraft } from "@rakazo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextProps,
  View,
} from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import {
  canMutateOutgoingDraft,
  draftEditorFromFields,
  type MobileOutgoingDraft,
  mapOutgoingDraft,
  type OutgoingDraftAnswer,
  type OutgoingDraftEditor,
  type OutgoingDraftVersion,
} from "../lib/outgoing-draft";

type MessageActionProps = Pick<
  TextProps,
  "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
>;

type DraftUpdateRequest = {
  approvalEffectId: string;
  draft: MobileOutgoingDraft;
  editor: OutgoingDraftEditor;
};

export function OutgoingDraftCard({
  draft: rawDraft,
  approvalEffectId,
  canAnswer,
  onAnswer,
  onUpdate,
  actionProps,
}: {
  draft: OutgoingMessageDraft;
  approvalEffectId?: string;
  canAnswer: boolean;
  onAnswer: (answer: OutgoingDraftAnswer, expected: OutgoingDraftVersion) => Promise<void>;
  onUpdate: (request: DraftUpdateRequest) => Promise<OutgoingMessageDraft>;
  actionProps: MessageActionProps;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const incoming = useMemo(() => mapOutgoingDraft(rawDraft), [rawDraft]);
  const [serverDraft, setServerDraft] = useState<MobileOutgoingDraft | null>(null);
  const draft = (serverDraft ?? incoming)!;
  const mutationLock = useRef(false);
  const [pendingAction, setPendingAction] = useState<OutgoingDraftAnswer | null>(null);
  const [awaitingSync, setAwaitingSync] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editor, setEditor] = useState<OutgoingDraftEditor | null>(null);
  const [editorBase, setEditorBase] = useState<MobileOutgoingDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewerUserId, setViewerUserId] = useState<string>();
  useEffect(() => {
    let active = true;
    setViewerUserId(undefined);
    if (!canAnswer || incoming?.status !== "pending" || !incoming.canApprove) return;
    void rpc<{ userId: string }>("me", {})
      .then((me) => {
        if (active) setViewerUserId(me.userId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [approvalEffectId, canAnswer, incoming?.status, incoming?.canApprove]);

  useEffect(() => {
    setServerDraft(null);
    setAwaitingSync(false);
  }, [incoming?.hash, incoming?.revision, incoming?.status]);

  if (!draft) return null;
  const canMutate =
    Boolean(approvalEffectId) && canMutateOutgoingDraft(draft, canAnswer, viewerUserId);
  const actionsEnabled = canMutate && !awaitingSync && pendingAction === null;
  const canEdit = canMutate && Boolean(approvalEffectId) && draft.editable.length > 0;

  async function answer(action: OutgoingDraftAnswer) {
    if (!actionsEnabled || mutationLock.current) return;
    mutationLock.current = true;
    setPendingAction(action);
    setActionError(null);
    try {
      await onAnswer(action, { revision: draft.revision, hash: draft.hash });
      // Keep actions locked until the authoritative projection changes.
      setAwaitingSync(true);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("Could not update draft"));
    } finally {
      mutationLock.current = false;
      setPendingAction(null);
    }
  }

  function openEditor() {
    if (!canEdit || mutationLock.current) return;
    setEditorBase(draft);
    setEditor(draftEditorFromFields(draft));
    setEditError(null);
  }

  function closeEditor() {
    if (saving) return;
    setEditor(null);
    setEditorBase(null);
    setEditError(null);
  }

  async function saveEditor() {
    if (!editor || !editorBase || !approvalEffectId || !canMutate || mutationLock.current) {
      return;
    }
    mutationLock.current = true;
    setSaving(true);
    setEditError(null);
    try {
      const response = await onUpdate({ approvalEffectId, draft: editorBase, editor });
      const updated = mapOutgoingDraft(response);
      if (!updated) throw new Error(t("Could not update draft"));
      setServerDraft(updated);
      setEditor(null);
      setEditorBase(null);
    } catch (cause) {
      // Keep the user's complete edits and stale base for an explicit conflict result.
      setEditError(cause instanceof Error ? cause.message : t("Could not update draft"));
    } finally {
      mutationLock.current = false;
      setSaving(false);
    }
  }

  const statusLabel =
    draft.status === "pending"
      ? t("Pending")
      : draft.status === "sending"
        ? t("Sending…")
        : draft.status === "sent"
          ? t("Sent")
          : draft.status === "discarded"
            ? t("Discarded")
            : draft.status === "failed"
              ? t("Failed")
              : draft.status === "uncertain"
                ? t("Delivery uncertain")
                : t("Unavailable");
  const statusColor =
    draft.status === "sent"
      ? tokens.success
      : draft.status === "failed" || draft.status === "uncertain"
        ? tokens.destructive
        : draft.status === "sending"
          ? tokens.warning
          : tokens.mutedForeground;

  const previewRows = [
    { key: "to", label: t("To"), value: draft.fields.to.join(", "), visible: true },
    {
      key: "cc",
      label: t("Cc"),
      value: draft.fields.cc?.join(", ") ?? "",
      visible: draft.fields.cc !== undefined,
    },
    {
      key: "bcc",
      label: t("Bcc"),
      value: draft.fields.bcc?.join(", ") ?? "",
      visible: draft.fields.bcc !== undefined,
    },
    {
      key: "subject",
      label: t("Subject"),
      value: draft.fields.subject ?? "",
      visible: draft.fields.subject !== undefined,
    },
  ].filter((row) => row.visible);

  return (
    <View style={[styles.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={styles.titleRow}>
        <Text
          {...actionProps}
          accessibilityRole="header"
          style={[styles.title, { color: tokens.foreground }]}
        >
          {t("Email draft")}
        </Text>
        <Text style={[styles.status, { color: statusColor }]}>{statusLabel}</Text>
      </View>
      {draft.account?.label ? (
        <DraftPreviewRow
          label={t("Account")}
          value={draft.account.label}
          color={tokens.foreground}
          mutedColor={tokens.mutedForeground}
        />
      ) : null}
      {previewRows.map((row) => (
        <DraftPreviewRow
          key={row.key}
          label={row.label}
          value={row.value}
          color={tokens.foreground}
          mutedColor={tokens.mutedForeground}
        />
      ))}
      <DraftPreviewRow
        label={t("Body")}
        value={draft.fields.body}
        color={tokens.foreground}
        mutedColor={tokens.mutedForeground}
      />
      {draft.metadata?.map((item, index) => (
        <DraftPreviewRow
          key={`${item.label}:${index}`}
          label={item.label}
          value={item.value}
          color={tokens.foreground}
          mutedColor={tokens.mutedForeground}
        />
      ))}
      {draft.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {draft.error}
        </Text>
      ) : null}
      {actionError ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {actionError}
        </Text>
      ) : null}
      {canMutate ? (
        <View style={styles.actions}>
          {canEdit ? (
            <DraftButton
              label={t("Edit")}
              disabled={!actionsEnabled}
              onPress={openEditor}
              background={tokens.muted}
              foreground={tokens.foreground}
            />
          ) : null}
          <DraftButton
            label={pendingAction === "discard" ? t("Discarding…") : t("Discard")}
            disabled={!actionsEnabled}
            onPress={() => void answer("discard")}
            background="transparent"
            foreground={tokens.destructive}
            border={tokens.border}
          />
          <DraftButton
            label={pendingAction === "send" ? t("Sending…") : t("Send")}
            disabled={!actionsEnabled}
            onPress={() => void answer("send")}
            background={tokens.primary}
            foreground={tokens.primaryForeground}
          />
        </View>
      ) : null}
      <Modal
        visible={editor !== null}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[styles.sheet, { backgroundColor: tokens.background }]}
        >
          <View style={[styles.sheetHeader, { borderBottomColor: tokens.border }]}>
            <Pressable
              accessibilityRole="button"
              disabled={saving}
              onPress={closeEditor}
              style={styles.headerButton}
            >
              <Text style={{ color: tokens.foreground }}>{t("Cancel")}</Text>
            </Pressable>
            <Text
              accessibilityRole="header"
              style={[styles.sheetTitle, { color: tokens.foreground }]}
            >
              {t("Edit draft")}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={saving || !canMutate}
              onPress={() => void saveEditor()}
              style={styles.headerButton}
            >
              <Text style={{ color: tokens.foreground, opacity: saving || !canMutate ? 0.5 : 1 }}>
                {saving ? t("Saving…") : t("Save")}
              </Text>
            </Pressable>
          </View>
          {editor ? (
            <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
              <DraftEditorField
                label={t("To")}
                field="to"
                multiline
                draft={draft}
                editor={editor}
                setEditor={setEditor}
              />
              {(draft.fields.cc !== undefined || draft.editable.includes("cc")) && (
                <DraftEditorField
                  label={t("Cc")}
                  field="cc"
                  multiline
                  draft={draft}
                  editor={editor}
                  setEditor={setEditor}
                />
              )}
              {(draft.fields.bcc !== undefined || draft.editable.includes("bcc")) && (
                <DraftEditorField
                  label={t("Bcc")}
                  field="bcc"
                  multiline
                  draft={draft}
                  editor={editor}
                  setEditor={setEditor}
                />
              )}
              {(draft.fields.subject !== undefined || draft.editable.includes("subject")) && (
                <DraftEditorField
                  label={t("Subject")}
                  field="subject"
                  draft={draft}
                  editor={editor}
                  setEditor={setEditor}
                />
              )}
              <DraftEditorField
                label={t("Body")}
                field="body"
                multiline
                draft={draft}
                editor={editor}
                setEditor={setEditor}
              />
              {draft.metadata?.map((item, index) => (
                <DraftPreviewRow
                  key={`${item.label}:${index}`}
                  label={item.label}
                  value={item.value}
                  color={tokens.foreground}
                  mutedColor={tokens.mutedForeground}
                />
              ))}
              {editError ? (
                <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
                  {editError}
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function DraftPreviewRow({
  label,
  value,
  color,
  mutedColor,
}: {
  label: string;
  value: string;
  color: string;
  mutedColor: string;
}) {
  return (
    <View style={styles.previewRow}>
      <Text style={[styles.fieldLabel, { color: mutedColor }]}>{label}</Text>
      <Text selectable style={[styles.fieldValue, { color }]}>
        {value}
      </Text>
    </View>
  );
}

function DraftEditorField({
  label,
  field,
  multiline,
  draft,
  editor,
  setEditor,
}: {
  label: string;
  field: keyof OutgoingDraftEditor;
  multiline?: boolean;
  draft: MobileOutgoingDraft;
  editor: OutgoingDraftEditor;
  setEditor: (editor: OutgoingDraftEditor) => void;
}) {
  const tokens = useMobileTokens();
  const editable = draft.editable.includes(field);
  return (
    <View style={styles.editorField}>
      <Text style={[styles.fieldLabel, { color: tokens.mutedForeground }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={editor[field]}
        editable={editable}
        multiline={multiline}
        autoCapitalize={field === "body" || field === "subject" ? "sentences" : "none"}
        autoCorrect={field === "body" || field === "subject"}
        onChangeText={(value) => setEditor({ ...editor, [field]: value })}
        style={[
          styles.input,
          multiline && styles.multilineInput,
          {
            borderColor: tokens.border,
            color: tokens.foreground,
            backgroundColor: editable ? tokens.card : tokens.muted,
          },
        ]}
      />
    </View>
  );
}

function DraftButton({
  label,
  disabled,
  onPress,
  background,
  foreground,
  border,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  background: string;
  foreground: string;
  border?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.actionButton,
        {
          backgroundColor: background,
          borderColor: border ?? background,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text style={{ color: foreground, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "90%",
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { flex: 1, fontSize: 15.5, fontWeight: "600" },
  status: { fontSize: 13, fontWeight: "600" },
  previewRow: { gap: 3 },
  fieldLabel: { fontSize: 12.5, fontWeight: "600" },
  fieldValue: { fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 },
  actionButton: {
    minHeight: 42,
    minWidth: 72,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  sheet: { flex: 1 },
  sheetHeader: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
  },
  sheetTitle: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600" },
  headerButton: { minWidth: 68, minHeight: 48, alignItems: "center", justifyContent: "center" },
  form: { padding: 20, gap: 16 },
  editorField: { gap: 6 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 15 },
  multilineInput: { minHeight: 88, textAlignVertical: "top" },
});
