import {
  ExecutionInspectionSchema,
  QueueImageSchema,
  QueueReplySchema,
  type QueueSnapshot,
  QueueSnapshotSchema,
} from "@rakazo/contracts";
import { type ExecutionClient, executionLabel } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
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
import { useMobileTokens } from "../lib/native";
import { pickFromLibrary } from "../lib/pick-attachments";
import { type QueueClient, queueRows, useExecution, useQueue } from "../lib/use-queue";
import { ExecutionFlowList } from "./ExecutionFlowList";
import { ModelSelectionControl } from "./ModelSelectionControl";

const executionClient: ExecutionClient = {
  inspect: async (input) => ExecutionInspectionSchema.parse(await rpc("execution/inspect", input)),
};

const client: QueueClient = {
  list: async (scope) => QueueSnapshotSchema.parse(await rpc("queue/list", scope)),
  mutate: async (input) => QueueReplySchema.parse(await rpc("queue/mutate", input)),
};
type Images = QueueSnapshot["rows"][number]["images"];
export function GroupQueueStrip({
  threadId,
  members,
  runIds,
  initialView,
  onClose,
}: {
  threadId: string;
  members: { botId: string; name: string }[];
  runIds: string[];
  initialView?: "queue" | "execution";
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [selected, setSelected] = useState(members[0]?.botId ?? "");
  const [choosing, setChoosing] = useState(Boolean(initialView) && members.length > 1);
  const member = members.find((item) => item.botId === selected) ?? members[0];
  if (!member) return null;
  return (
    <View>
      {!initialView && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Queue for bot")}
          style={styles.button}
          onPress={() => setChoosing(true)}
        >
          <Text style={{ color: tokens.foreground }}>{member.name}</Text>
        </Pressable>
      )}
      <Modal
        visible={choosing}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={() => (onClose ? onClose() : setChoosing(false))}
      >
        <View style={[styles.sheet, { backgroundColor: tokens.background }]}>
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            onPress={() => (onClose ? onClose() : setChoosing(false))}
          >
            <Text style={{ color: tokens.foreground }}>{t("Close")}</Text>
          </Pressable>
          <FlatList
            data={members}
            keyExtractor={(item) => item.botId}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: item.botId === member.botId }}
                style={styles.button}
                onPress={() => {
                  setSelected(item.botId);
                  setChoosing(false);
                }}
              >
                <Text style={{ color: tokens.foreground }}>{item.name}</Text>
              </Pressable>
            )}
          />
        </View>
      </Modal>
      {!choosing && (
        <QueueStrip
          key={`${threadId}:${member.botId}`}
          threadId={threadId}
          botId={member.botId}
          runIds={runIds}
          initialView={initialView}
          onClose={onClose}
        />
      )}
    </View>
  );
}

export function QueueStrip({
  threadId,
  botId,
  runIds = [],
  initialView,
  onClose,
}: {
  threadId: string;
  botId: string;
  runIds?: string[];
  initialView?: "queue" | "execution";
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const queue = useQueue(client, threadId, botId);
  const { snapshot, error, busy: queueBusy, mutate } = queue;
  const [attaching, setAttaching] = useState(false);
  const busy = queueBusy || attaching;
  const [open, setOpen] = useState(initialView === "queue");
  const [inspect, setInspect] = useState(initialView === "execution");
  const closeQueue = () => (onClose ? onClose() : setOpen(false));
  const closeInspect = () => (onClose ? onClose() : setInspect(false));
  const [text, setText] = useState("");
  const [images, setImages] = useState<Images>([]);
  const [lane, setLane] = useState<"steer" | "followUp">("followUp");
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<Images>([]);
  const selected = snapshot?.editing?.selectedId;
  const disabled = busy || !snapshot;
  const draftId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (draftId.current === selected) return;
    draftId.current = selected;
    const row = snapshot?.editing?.rows.find((item) => item.id === selected);
    if (row) {
      setDraft(row.text);
      setDraftImages(row.images);
    }
  }, [selected, snapshot]);
  const labelStyle = { color: tokens.foreground };
  function button(label: string, action: () => void, blocked = disabled) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={blocked}
        onPress={action}
        style={[styles.button, { opacity: blocked ? 0.4 : 1 }]}
      >
        <Text style={labelStyle}>{label}</Text>
      </Pressable>
    );
  }
  async function attach(editing: boolean) {
    if (busy) return;
    setAttaching(true);
    try {
      const previous = editing ? draftImages : images;
      const picked = await pickFromLibrary(previous.length);
      if (picked.skipped.length)
        Alert.alert(
          t("Attachments"),
          picked.skipped.map((item) => `${item.name}: ${item.reason}`).join("\n"),
        );
      const next = picked.attachments.map((item) =>
        QueueImageSchema.parse({
          type: "image",
          mimeType: item.mimeType,
          data: item.contentBase64,
        }),
      );
      (editing ? setDraftImages : setImages)([...previous, ...next]);
    } catch (cause) {
      Alert.alert(t("Attachments"), String(cause));
    } finally {
      setAttaching(false);
    }
  }
  function previews(items: Images, change?: (next: Images) => void) {
    return (
      <View style={styles.controls}>
        {items.map((image, index) => (
          <View key={index}>
            <Image
              accessibilityLabel={t("Attachment")}
              source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
              style={styles.image}
            />
            {change &&
              button(t("Remove attachment"), () => change(items.filter((_, i) => i !== index)))}
          </View>
        ))}
      </View>
    );
  }
  function resume() {
    if (snapshot?.uncertainRowIds.length)
      Alert.alert(
        t("Resume uncertain deliveries?"),
        t("A delivery may already have reached the bot. Resuming can send it again."),
        [
          { text: t("Cancel"), style: "cancel" },
          { text: t("Resume"), onPress: () => void mutate({ type: "resume" }) },
        ],
      );
    else void mutate({ type: snapshot?.paused || snapshot?.errorHold ? "resume" : "pause" });
  }
  return (
    <View>
      {!initialView && (
        <View style={styles.controls}>
          {button(
            `${t("Queue")} · ${snapshot?.rows.length ?? "…"}${snapshot?.paused ? ` · ${t("Paused")}` : ""}`,
            () => setOpen(true),
            false,
          )}
          {error || snapshot?.errorHold || snapshot?.uncertainRowIds.length ? (
            <Text style={{ color: tokens.destructive }}>{t("Needs attention")}</Text>
          ) : null}
          {runIds.length > 0 && button(t("Execution"), () => setInspect(true), false)}
        </View>
      )}
      <Modal
        visible={open}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={closeQueue}
      >
        <View style={[styles.sheet, { backgroundColor: tokens.background }]}>
          <View style={styles.controls}>
            <Text accessibilityRole="header" style={labelStyle}>
              {t("Queue")}
            </Text>
            {button(t("Close"), closeQueue, false)}
          </View>
          {error && (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {error}
            </Text>
          )}
          <View style={styles.controls}>
            {button(snapshot?.paused || snapshot?.errorHold ? t("Resume") : t("Pause"), resume)}
            {button(
              snapshot?.gracefulPausePending ? t("Pause pending") : t("Pause after tools"),
              () => void mutate({ type: "graceful-pause" }),
              disabled || snapshot?.gracefulPausePending,
            )}
          </View>
          {snapshot?.errorHold && <Text style={labelStyle}>{t("Recovery hold")}</Text>}
          {snapshot?.compaction && (
            <Text style={labelStyle}>
              {t("Compaction")} · {snapshot.compaction}
            </Text>
          )}
          {snapshot?.inFlight && (
            <Text style={labelStyle}>
              {t("Delivery pending")} · {snapshot.inFlight.rowIds.join(", ")}
            </Text>
          )}
          <FlatList
            data={snapshot ? queueRows(snapshot) : []}
            keyExtractor={(row) => row.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: row }) => (
              <View
                style={[
                  styles.row,
                  { borderColor: tokens.border, marginStart: row.lane === "steer" ? 20 : 0 },
                ]}
              >
                <Text style={{ color: tokens.mutedForeground }}>
                  {row.lane === "steer" ? t("Steer") : t("Follow-up")}
                  {row.paused ? ` · ${t("Held")}` : ""}
                </Text>
                {snapshot?.uncertainRowIds.includes(row.id) && (
                  <Text style={{ color: tokens.destructive }}>{t("Delivery uncertain")}</Text>
                )}
                {row.target && (
                  <Text style={labelStyle}>
                    {t("Participant")} · {row.target.participantId}
                  </Text>
                )}
                {row.placement?.kind === "unbound" &&
                  button(
                    t("Use current project"),
                    () => void mutate({ type: "bind-placement", id: row.id }),
                    disabled || Boolean(snapshot?.editing) || Boolean(snapshot?.inFlight),
                  )}
                {selected === row.id ? (
                  <>
                    <TextInput
                      accessibilityLabel={t("Edit queued message")}
                      multiline
                      value={draft}
                      onChangeText={setDraft}
                      editable={!busy}
                      style={[styles.input, labelStyle, { borderColor: tokens.border }]}
                    />
                    {previews(draftImages, setDraftImages)}
                    <View style={styles.controls}>
                      {button(t("Attach"), () => void attach(true))}
                      {button(
                        t("Save"),
                        () =>
                          void (async () => {
                            if (
                              await mutate({
                                type: "edit-patch",
                                patch: { text: draft, images: draftImages },
                              })
                            )
                              await mutate({ type: "edit-save" });
                          })(),
                      )}
                      {button(t("Cancel"), () => void mutate({ type: "edit-cancel" }))}
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={labelStyle}>{row.text}</Text>
                    {previews(row.images)}
                    {button(
                      t("Edit"),
                      () =>
                        void (async () => {
                          if (await mutate({ type: "edit-begin", id: row.id })) {
                            setDraft(row.text);
                            setDraftImages(row.images);
                          }
                        })(),
                      disabled || Boolean(selected),
                    )}
                  </>
                )}
                <View style={styles.controls}>
                  {button(
                    t("Move up"),
                    () => void mutate({ type: "reorder", id: row.id, direction: -1 }),
                    disabled || Boolean(selected),
                  )}
                  {button(
                    t("Move down"),
                    () => void mutate({ type: "reorder", id: row.id, direction: 1 }),
                    disabled || Boolean(selected),
                  )}
                  {button(
                    row.lane === "steer" ? t("Follow-up") : t("Steer"),
                    () =>
                      void mutate({
                        type: "lane",
                        id: row.id,
                        lane: row.lane === "steer" ? "followUp" : "steer",
                      }),
                    disabled || Boolean(selected),
                  )}
                  {button(
                    row.paused ? t("Release hold") : t("Hold"),
                    () => void mutate({ type: "hold", id: row.id, paused: !row.paused }),
                    disabled || Boolean(selected),
                  )}
                  {button(
                    t("Remove"),
                    () => void mutate({ type: "remove", id: row.id }),
                    disabled || Boolean(selected),
                  )}
                </View>
              </View>
            )}
            ListFooterComponent={
              <View>
                <TextInput
                  editable={!busy}
                  accessibilityLabel={t("Queued message")}
                  multiline
                  value={text}
                  onChangeText={setText}
                  style={[styles.input, labelStyle, { borderColor: tokens.border }]}
                />
                {previews(images, setImages)}
                <View style={styles.controls}>
                  {button(lane === "steer" ? t("Steer") : t("Follow-up"), () =>
                    setLane(lane === "steer" ? "followUp" : "steer"),
                  )}
                  {button(t("Attach"), () => void attach(false))}
                  {button(
                    t("Queue message"),
                    () =>
                      void (async () => {
                        if (await mutate({ type: "enqueue", text, images, lane })) {
                          setText("");
                          setImages([]);
                        }
                      })(),
                    disabled || (!text.trim() && !images.length),
                  )}
                </View>
              </View>
            }
          />
        </View>
      </Modal>
      <Modal
        visible={inspect}
        presentationStyle="pageSheet"
        animationType="slide"
        onRequestClose={closeInspect}
      >
        <View style={[styles.sheet, { backgroundColor: tokens.background }]}>
          {button(t("Close"), closeInspect, false)}
          {inspect && (
            <ExecutionList
              key={`${threadId}:${botId}`}
              runIds={runIds}
              queue={queue}
              botId={botId}
              threadId={threadId}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

type SteeringQueue = ReturnType<typeof useQueue>;

function ExecutionList({
  runIds,
  queue,
  botId,
  threadId,
}: {
  runIds: string[];
  queue: SteeringQueue;
  botId: string;
  threadId: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [runId, setRunId] = useState(runIds[0] ?? "");
  const runs = [...new Set([...runIds, runId])].filter(Boolean);
  return (
    <View style={{ flex: 1 }}>
      {runs.length > 1 && (
        <ScrollView horizontal style={{ flexGrow: 0 }}>
          {runs.map((id, index) => (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityState={{ selected: runId === id }}
              onPress={() => setRunId(id)}
              style={styles.button}
            >
              <Text style={{ color: tokens.foreground }}>
                {t("Run {number}", { number: index + 1 })}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {!runId && <Text style={{ color: tokens.mutedForeground }}>{t("No retained events")}</Text>}
      {runId && (
        <ExecutionEvents
          key={runId}
          runId={runId}
          runIds={runs}
          onRun={setRunId}
          queue={queue}
          botId={botId}
          threadId={threadId}
        />
      )}
    </View>
  );
}
function ExecutionEvents({
  runId,
  runIds,
  onRun,
  queue,
  botId,
  threadId,
}: {
  botId: string;
  threadId: string;
  runId: string;
  runIds: string[];
  onRun: (runId: string) => void;
  queue: SteeringQueue;
}) {
  const [target, setTarget] = useState<string>();
  const [message, setMessage] = useState("");
  const [flow, setFlow] = useState(false);
  const [evidence, setEvidence] = useState<string[]>();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { inspection: data, busy, error, loadMore } = useExecution(executionClient, runId);
  const [expanded, setExpanded] = useState<string>();
  return (
    <>
      {data?.participants
        .filter((participant) => participant.botId === botId && participant.participantId)
        .map((participant, index) => (
          <View key={`model:${participant.participantId}`}>
            <Text style={{ color: tokens.mutedForeground }}>
              {participant.name ?? t("Participant {number}", { number: index + 1 })}
            </Text>
            <ModelSelectionControl
              botId={botId}
              worker={{ threadId, participantId: participant.participantId! }}
            />
          </View>
        ))}
      {data &&
        queue.steeringParticipants(data).map((participant, index) => (
          <Pressable
            key={participant.participantId}
            accessibilityRole="button"
            style={styles.button}
            onPress={() => {
              setTarget(participant.participantId);
              setMessage("");
            }}
          >
            <Text style={{ color: tokens.foreground }}>
              {t("Steer participant")} ·{" "}
              {participant.name ?? t("Participant {number}", { number: index + 1 })}
            </Text>
          </Pressable>
        ))}
      {data &&
        target &&
        queue.steeringParticipants(data).some((item) => item.participantId === target) && (
          <View>
            <Text style={{ color: tokens.foreground }}>
              {queue.steeringParticipants(data).find((item) => item.participantId === target)
                ?.name ??
                t("Participant {number}", {
                  number:
                    queue
                      .steeringParticipants(data)
                      .findIndex((item) => item.participantId === target) + 1,
                })}
            </Text>
            <TextInput
              accessibilityLabel={t("Message to participant")}
              multiline
              value={message}
              onChangeText={setMessage}
              editable={!queue.busy}
              style={[styles.input, { color: tokens.foreground, borderColor: tokens.border }]}
            />
            {queue.error && (
              <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
                {queue.error}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              disabled={queue.busy || !queue.snapshot || !message.trim()}
              onPress={() =>
                void (async () => {
                  if (await queue.steer(data, target, message)) {
                    setTarget(undefined);
                    setMessage("");
                  }
                })()
              }
            >
              <Text style={{ color: tokens.foreground }}>{t("Queue message")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              disabled={queue.busy}
              onPress={() => setTarget(undefined)}
            >
              <Text style={{ color: tokens.foreground }}>{t("Cancel")}</Text>
            </Pressable>
          </View>
        )}
      {error && (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: flow }}
        style={styles.button}
        onPress={() => setFlow(!flow)}
      >
        <Text style={{ color: tokens.foreground }}>{t("Flow")}</Text>
      </Pressable>
      {flow && data ? (
        <ExecutionFlowList
          flow={data.flow}
          rootRunId={runId}
          runIds={runIds}
          onRun={(id) => {
            setEvidence(undefined);
            setFlow(false);
            onRun(id);
          }}
          onEvidence={(ids) => {
            setEvidence(ids);
            setFlow(false);
          }}
        />
      ) : (
        <FlatList
          ListHeaderComponent={
            evidence ? (
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => setEvidence(undefined)}
              >
                <Text style={{ color: tokens.foreground }}>{t("All events")}</Text>
              </Pressable>
            ) : null
          }
          data={(data?.events ?? []).filter((event) => !evidence || evidence.includes(event.id))}
          keyExtractor={(event) => event.id}
          ListEmptyComponent={
            !busy && !error ? (
              <Text style={{ color: tokens.mutedForeground }}>{t("No retained events")}</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={[styles.row, { borderColor: tokens.border }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: expanded === item.id }}
                onPress={() => setExpanded(expanded === item.id ? undefined : item.id)}
              >
                <Text style={{ color: tokens.foreground }}>
                  {item.seq} · {executionLabel(item)}
                </Text>
                <Text style={{ color: tokens.mutedForeground }}>
                  {item.botId} · {item.createdAt}
                </Text>
              </Pressable>
              {expanded === item.id && (
                <Text selectable style={{ color: tokens.foreground, fontFamily: "monospace" }}>
                  {JSON.stringify(item.payload, null, 2)}
                </Text>
              )}
            </View>
          )}
        />
      )}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void loadMore()}
        style={styles.button}
      >
        <Text style={{ color: tokens.foreground }}>
          {data?.hasMore ? t("Load more") : t("Refresh")}
        </Text>
      </Pressable>
    </>
  );
}
const styles = StyleSheet.create({
  sheet: { flex: 1, padding: 16, paddingTop: 28 },
  controls: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  button: { paddingHorizontal: 10, paddingVertical: 12, minHeight: 44 },
  row: { borderWidth: 1, borderRadius: 12, padding: 10, marginVertical: 4 },
  input: { borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 60 },
  image: { width: 56, height: 56, borderRadius: 8 },
});
