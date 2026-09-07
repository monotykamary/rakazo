import type { ExecutionFlow } from "@rakazo/contracts";
import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ExecutionFlowList({
  flow,
  onRun,
  onEvidence,
}: {
  flow: ExecutionFlow;
  onRun: (runId: string) => void;
  onEvidence: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [expanded, setExpanded] = useState<string>();
  const [edgeId, setEdgeId] = useState<string>();
  const nodes = flow.nodes.filter((node) => node.evidence.length > 0);
  const foreground = { color: tokens.foreground };
  const muted = { color: tokens.mutedForeground };
  return (
    <FlatList
      data={nodes}
      keyExtractor={(node) => node.id}
      ListEmptyComponent={<Text style={muted}>{t("No retained relationships")}</Text>}
      renderItem={({ item: node }) => (
        <View style={[styles.node, { borderColor: tokens.border }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: expanded === node.id }}
            onPress={() => setExpanded(expanded === node.id ? undefined : node.id)}
            style={styles.button}
          >
            <Text style={muted}>
              {node.kind}
              {node.status ? ` · ${node.status}` : ""}
            </Text>
            <Text style={foreground}>{node.name ?? node.id}</Text>
          </Pressable>
          {expanded === node.id && (
            <View>
              {node.code && (
                <Text selectable style={[foreground, { fontFamily: "monospace" }]}>
                  {node.code}
                </Text>
              )}
              {node.runId && (
                <Pressable
                  accessibilityRole="button"
                  style={styles.button}
                  onPress={() => onRun(node.runId!)}
                >
                  <Text style={foreground}>{t("Inspect run")}</Text>
                </Pressable>
              )}
              {node.evidence.map((item) => (
                <Text key={`${item.kind}:${item.id}`} style={muted}>
                  {item.kind} · {item.id}
                </Text>
              ))}
              {node.evidence.some((item) => item.kind === "event") && (
                <Pressable
                  accessibilityRole="button"
                  style={styles.button}
                  onPress={() =>
                    onEvidence(
                      node.evidence.filter((item) => item.kind === "event").map((item) => item.id),
                    )
                  }
                >
                  <Text style={foreground}>{t("Show events")}</Text>
                </Pressable>
              )}
            </View>
          )}
          {flow.edges
            .filter(
              (edge) =>
                edge.from === node.id &&
                edge.evidence.length > 0 &&
                nodes.some((target) => target.id === edge.to),
            )
            .map((edge) => (
              <View key={edge.id}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: edgeId === edge.id }}
                  style={styles.button}
                  onPress={() => setEdgeId(edgeId === edge.id ? undefined : edge.id)}
                >
                  <Text style={foreground}>
                    {edge.kind} → {nodes.find((target) => target.id === edge.to)?.name ?? edge.to}
                  </Text>
                </Pressable>
                {edgeId === edge.id && (
                  <View>
                    {edge.evidence.map((item) => (
                      <Text key={`${item.kind}:${item.id}`} style={muted}>
                        {item.kind} · {item.id}
                      </Text>
                    ))}
                    <Pressable
                      accessibilityRole="button"
                      style={styles.button}
                      onPress={() =>
                        onEvidence(
                          edge.evidence
                            .filter((item) => item.kind === "event")
                            .map((item) => item.id),
                        )
                      }
                    >
                      <Text style={foreground}>{t("Show events")}</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))}
        </View>
      )}
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
  node: { borderWidth: 1, borderRadius: 12, padding: 8, marginVertical: 4 },
  button: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 4 },
});
