import type { ExecutionFlow, ExecutionFlowEdge, ExecutionFlowNode } from "@rakazo/contracts";
import { executionFlowRows } from "@rakazo/core";
import { useState } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { NativeSymbol } from "./native-symbol";

const nodeIcons = {
  run: { ios: "play.circle", android: "play-circle-outline" },
  participant: { ios: "person.crop.circle", android: "person-circle-outline" },
  execution: { ios: "curlybraces", android: "code-slash-outline" },
  message: { ios: "bubble.left", android: "chatbubble-outline" },
  wait: { ios: "hourglass", android: "time-outline" },
  recovery: { ios: "arrow.clockwise", android: "refresh-outline" },
} as const;

export function ExecutionFlowList({
  flow,
  rootRunId,
  runIds = [],
  onRun,
  onEvidence,
}: {
  flow: ExecutionFlow;
  rootRunId?: string;
  runIds?: string[];
  onRun: (runId: string) => void;
  onEvidence: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const runTitle = (id: string | undefined, ordinal: number) => {
    const index = runIds.indexOf(id ?? "");
    return index >= 0
      ? t("Run {number}", { number: index + 1 })
      : t("Related run {number}", { number: ordinal });
  };
  const [expandedId, setExpandedId] = useState<string>();
  const [edgeId, setEdgeId] = useState<string>();
  const [showEvidence, setShowEvidence] = useState(false);
  const rows = executionFlowRows(flow, rootRunId);
  const foreground = { color: tokens.foreground };
  const muted = { color: tokens.mutedForeground };
  function title(node: ExecutionFlowNode, number: number, relationships: ExecutionFlowEdge[]) {
    if (node.name) {
      if (node.kind === "execution" || node.kind === "recovery") {
        const name = node.name.replace(/[_.]+/g, " ");
        return name.charAt(0).toUpperCase() + name.slice(1);
      }
      if (node.kind !== "wait") return node.name;
    }
    switch (node.kind) {
      case "run":
        return t("Run {number}", { number });
      case "execution":
        return t("Execution {number}", { number });
      case "participant":
        return t("Participant {number}", { number });
      case "message":
        if (relationships.some((edge) => edge.kind === "results")) return t("Result");
        if (relationships.some((edge) => edge.kind === "replies")) return t("Reply");
        return t("Message {number}", { number });
      case "wait":
        return t("Waiting for input");
      case "recovery":
        return t("Recovery");
    }
  }
  function relationLabel(kind: ExecutionFlowEdge["kind"]) {
    switch (kind) {
      case "contains":
        return t("Includes");
      case "calls":
        return t("Calls");
      case "delegates":
        return t("Delegates to");
      case "waits-for":
        return t("Waits for");
      case "continues":
        return t("Continues");
      case "starts":
        return t("Starts");
      case "results":
        return t("Returns to");
      case "messages":
        return t("Messages");
      case "replies":
        return t("Replies to");
    }
  }
  function statusLabel(status?: string) {
    switch (status?.replace(/^run\./, "")) {
      case "completed":
        return t("Completed");
      case "failed":
        return t("Failed");
      case "cancelled":
        return t("Cancelled");
      case "stopped":
        return t("Stopped");
      case "running":
      case "active":
      case "busy":
      case "streaming":
        return t("Running");
      case "waiting":
      case "waiting_input":
        return t("Waiting");
      case "pending":
      case "queued":
        return t("Pending");
      default:
        return undefined;
    }
  }
  const ordinals = new Map<ExecutionFlowNode["kind"], number>();
  const names = new Map(
    rows.map(({ node, relationships }) => {
      const ordinal = (ordinals.get(node.kind) ?? 0) + 1;
      ordinals.set(node.kind, ordinal);
      return [node.id, title(node, ordinal, relationships)] as const;
    }),
  );
  return (
    <FlatList
      data={rows}
      keyExtractor={({ node }) => node.id}
      contentContainerStyle={styles.content}
      style={{
        borderColor: tokens.border,
        borderWidth: 1,
        borderRadius: 12,
        backgroundColor: tokens.card,
      }}
      ListEmptyComponent={<Text style={muted}>{t("No retained relationships")}</Text>}
      renderItem={({ item: { node, depth, parent, relationships, runs } }) => {
        const expanded = expandedId === node.id;
        const edge = expanded ? relationships.find((item) => item.id === edgeId) : undefined;
        const evidence = edge?.evidence ?? node.evidence;
        const eventIds = evidence.filter((item) => item.kind === "event").map((item) => item.id);
        const focusedRun = runs.find((run) => run.runId === rootRunId);
        const focusedStatus = focusedRun?.status ?? node.status;
        const code =
          node.code ?? focusedRun?.code ?? (runs.length === 1 ? runs[0]?.code : undefined);
        const status =
          statusLabel(focusedStatus) ??
          (runs.length > 1 ? t("{count} runs", { count: runs.length }) : undefined);
        const failed = focusedStatus === "failed" || focusedStatus === "run.failed";
        return (
          <View style={{ marginStart: Math.min(depth, 3) * 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => {
                setExpandedId(expanded ? undefined : node.id);
                setEdgeId(undefined);
                setShowEvidence(false);
              }}
              style={[styles.row, expanded && { backgroundColor: tokens.muted }]}
            >
              <NativeSymbol {...nodeIcons[node.kind]} size={18} color={tokens.mutedForeground} />
              <View style={styles.label}>
                {parent && (
                  <Text style={[styles.caption, muted]}>{relationLabel(parent.kind)}</Text>
                )}
                <Text numberOfLines={2} style={[styles.title, foreground]}>
                  {names.get(node.id)}
                </Text>
              </View>
              {status && (
                <Text
                  style={[
                    styles.caption,
                    { color: failed ? tokens.destructive : tokens.mutedForeground },
                  ]}
                >
                  {status}
                </Text>
              )}
              <NativeSymbol
                ios={expanded ? "chevron.down" : "chevron.forward"}
                android={expanded ? "chevron-down" : "chevron-forward"}
                size={14}
                color={tokens.mutedForeground}
              />
            </Pressable>
            {expanded && (
              <View style={[styles.details, { borderColor: tokens.border }]}>
                {relationships.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: edgeId === item.id }}
                    style={[styles.action, edgeId === item.id && { backgroundColor: tokens.muted }]}
                    onPress={() => {
                      setEdgeId(edgeId === item.id ? undefined : item.id);
                      setShowEvidence(false);
                    }}
                  >
                    <Text style={foreground}>
                      {relationLabel(item.kind)} {names.get(item.to)}
                    </Text>
                  </Pressable>
                ))}
                {!edge && code && (
                  <Text selectable style={[styles.code, foreground]}>
                    {code}
                  </Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showEvidence }}
                  style={styles.action}
                  onPress={() => setShowEvidence(!showEvidence)}
                >
                  <Text style={[styles.caption, muted]}>{t("Evidence")}</Text>
                </Pressable>
                {showEvidence &&
                  evidence.map((item) => (
                    <Text
                      selectable
                      key={`${item.kind}:${item.id}`}
                      style={[styles.caption, muted]}
                    >
                      {item.kind} · {item.id}
                    </Text>
                  ))}
                <View style={styles.actions}>
                  {!edge &&
                    runs.length > 1 &&
                    runs.map((run, index) => (
                      <Pressable
                        key={run.id}
                        accessibilityRole="button"
                        accessibilityState={{
                          selected: run.runId === rootRunId,
                          disabled: !run.runId,
                        }}
                        disabled={!run.runId}
                        style={styles.action}
                        onPress={() => {
                          if (run.runId) onRun(run.runId);
                        }}
                      >
                        <Text style={foreground}>{runTitle(run.runId, index + 1)}</Text>
                      </Pressable>
                    ))}
                  {!edge && node.runId && (
                    <Pressable
                      accessibilityRole="button"
                      style={styles.action}
                      onPress={() => {
                        if (node.runId) onRun(node.runId);
                      }}
                    >
                      <Text style={foreground}>{t("Inspect run")}</Text>
                    </Pressable>
                  )}
                  {eventIds.length > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      style={styles.action}
                      onPress={() => onEvidence(eventIds)}
                    >
                      <Text style={foreground}>{t("Show events")}</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}
          </View>
        );
      }}
      ListFooterComponent={
        flow.hasMoreRelatedRuns ? (
          <Text style={muted}>
            {t("More related runs are available. Open a run to inspect it.")}
          </Text>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 8, gap: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 52,
    padding: 8,
    borderRadius: 8,
  },
  label: { flex: 1, minWidth: 0 },
  caption: { fontSize: 12, lineHeight: 16 },
  title: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  details: {
    marginVertical: 8,
    marginStart: 8,
    borderStartWidth: 1,
    paddingStart: 12,
    paddingEnd: 4,
    gap: 8,
  },
  action: {
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  code: { fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
});
