import type { ExecutionFlow, ExecutionFlowEdge, ExecutionFlowNode } from "@rakazo/contracts";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const evidenceUnion = (...groups: ExecutionFlowNode["evidence"][]) =>
  [
    ...new Map(
      groups.flat().map((item) => [JSON.stringify([item.kind, item.id]), { ...item }]),
    ).values(),
  ].sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));

/** A presentation-only outline; retained evidence, not page order, determines relationships. */
export function executionFlowRows(
  flow: ExecutionFlow,
  rootRunId?: string,
): Array<{
  node: ExecutionFlowNode;
  depth: number;
  parent?: ExecutionFlowEdge;
  relationships: ExecutionFlowEdge[];
  runs: ExecutionFlowNode[];
}> {
  const nodes = new Map(
    flow.nodes.filter((node) => node.evidence.length).map((node) => [node.id, node]),
  );
  const edges = flow.edges.filter(
    (edge) => edge.evidence.length && nodes.has(edge.from) && nodes.has(edge.to),
  );
  const owners = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== "message" || node.code || node.name) continue;
    const candidates = new Set<string>();
    if (node.runId) candidates.add(node.runId);
    for (const edge of edges) {
      const source = nodes.get(edge.from)!;
      if (edge.to === node.id && edge.kind === "contains" && source.kind === "run") {
        candidates.add(source.runId ?? source.id);
      }
    }
    if (candidates.size !== 1) continue;
    const [runId] = candidates;
    const matches = [...nodes.values()].filter(
      (run) => run.kind === "run" && (run.runId ?? run.id) === runId,
    );
    if (matches.length === 1) owners.set(node.id, matches[0]!.id);
  }
  const groups = new Map<string, ExecutionFlowNode[]>();
  const aliases = new Map<string, string>();
  for (const node of nodes.values()) {
    if (!node.botId || (node.kind !== "run" && (node.kind !== "participant" || node.participantId)))
      continue;
    const id = `bot:${node.botId}`;
    aliases.set(node.id, id);
    groups.set(id, [...(groups.get(id) ?? []), node]);
  }
  const identity = (id: string) => aliases.get(id) ?? id;
  const retainedRuns = new Map<string, ExecutionFlowNode[]>();
  const retained = new Map(
    [...nodes]
      .filter(([id]) => !owners.has(id))
      .map(([id, node]) => [id, { ...node, evidence: evidenceUnion(node.evidence) }]),
  );
  // Resolve ownership against original runs, then fold their actor aliases.
  for (const [id, members] of groups) {
    const sorted = [...members].sort((a, b) => compare(a.id, b.id));
    const runs = sorted.filter((node) => node.kind === "run");
    retainedRuns.set(id, runs);
    for (const member of members) retained.delete(member.id);
    retained.set(id, {
      id,
      kind: "participant",
      botId: sorted[0]!.botId,
      name: runs.find((node) => node.name)?.name ?? sorted.find((node) => node.name)?.name,
      runId: runs.length === 1 ? runs[0]!.runId : undefined,
      status: runs.length === 1 ? runs[0]!.status : undefined,
      evidence: evidenceUnion(...members.map((node) => node.evidence)),
    });
  }
  for (const [id, owner] of owners) {
    const run = retained.get(identity(owner))!;
    run.evidence = evidenceUnion(run.evidence, nodes.get(id)!.evidence);
  }
  const links = new Map<string, ExecutionFlowEdge>();
  for (const edge of [...edges].sort((a, b) => compare(a.id, b.id))) {
    const from = identity(owners.get(edge.from) ?? edge.from);
    const to = identity(owners.get(edge.to) ?? edge.to);
    const evidence = evidenceUnion(
      edge.evidence,
      owners.has(edge.from) ? nodes.get(edge.from)!.evidence : [],
      owners.has(edge.to) ? nodes.get(edge.to)!.evidence : [],
    );
    if (from === to && edge.from !== edge.to) {
      const node = retained.get(from)!;
      node.evidence = evidenceUnion(node.evidence, evidence);
      continue;
    }
    const key = JSON.stringify([edge.kind, from, to]);
    const prior = links.get(key);
    links.set(key, {
      ...edge,
      id: prior?.id ?? edge.id,
      from,
      to,
      evidence: evidenceUnion(prior?.evidence ?? [], evidence),
    });
  }
  for (const node of nodes.values()) {
    if (node.kind === "run" && !aliases.has(node.id)) retainedRuns.set(node.id, [node]);
  }
  // Only a single transport route is safe to bypass. Semantic back-links survive.
  for (const [id, node] of [...retained].sort(([a], [b]) => compare(a, b))) {
    if (node.kind !== "message" || node.code || node.name) continue;
    const incoming = [...links.values()].filter((edge) => edge.to === id);
    const outgoing = [...links.values()].filter((edge) => edge.from === id);
    if (
      !incoming.length ||
      !outgoing.length ||
      new Set(incoming.map((edge) => edge.from)).size !== 1 ||
      new Set(outgoing.map((edge) => edge.to)).size !== 1 ||
      incoming.some((edge) => edge.from === id || edge.kind !== "messages") ||
      outgoing.some(
        (edge) => !["starts", "continues", "messages", "replies", "results"].includes(edge.kind),
      )
    )
      continue;
    for (const first of incoming)
      for (const last of outgoing) {
        const kind = last.kind === "starts" || last.kind === "continues" ? "messages" : last.kind;
        const evidence = evidenceUnion(first.evidence, node.evidence, last.evidence);
        if (first.from === last.to) {
          const actor = retained.get(first.from)!;
          actor.evidence = evidenceUnion(actor.evidence, evidence);
        } else {
          const key = JSON.stringify([kind, first.from, last.to]);
          const prior = links.get(key);
          links.set(key, {
            ...last,
            id: prior?.id ?? JSON.stringify(["bridge", first.id, last.id]),
            from: first.from,
            kind,
            evidence: evidenceUnion(prior?.evidence ?? [], evidence),
          });
        }
      }
    for (const [key, edge] of links) if (edge.from === id || edge.to === id) links.delete(key);
    retained.delete(id);
  }
  const rootNode = [...nodes.values()].find(
    (node) => node.kind === "run" && (node.runId ?? node.id) === rootRunId,
  );
  const root = rootNode ? identity(rootNode.id) : undefined;
  const rank = (edge: ExecutionFlowEdge) => {
    switch (edge.kind) {
      case "calls":
        return 0;
      case "delegates":
        return 1;
      case "contains":
        return retained.get(edge.from)?.kind === "run" ? 3 : 2;
      case "waits-for":
        return 4;
      case "continues":
        return 5;
      case "starts":
        return 6;
      case "messages":
        return 7;
      case "replies":
        return 8;
      case "results":
        return 9;
    }
  };
  const ordered = [...links.values()].sort(
    (a, b) =>
      rank(a) - rank(b) || compare(a.from, b.from) || compare(a.to, b.to) || compare(a.id, b.id),
  );
  const parents = new Map<string, ExecutionFlowEdge>();
  const outgoing = new Map<string, ExecutionFlowEdge[]>();
  for (const edge of ordered) {
    const relationships = outgoing.get(edge.from) ?? [];
    relationships.push(edge);
    outgoing.set(edge.from, relationships);
    // Back-links and original self relationships remain inspectable, never causal parents.
    if (edge.from === edge.to || edge.kind === "replies" || edge.kind === "results") continue;
    if (edge.to === root || parents.has(edge.to)) continue;
    let ancestor = edge.from;
    while (ancestor !== edge.to && parents.has(ancestor)) ancestor = parents.get(ancestor)!.from;
    if (ancestor !== edge.to) parents.set(edge.to, edge);
  }
  const children = new Map<string, string[]>();
  const ids = [...retained.keys()].sort((a, b) =>
    a === root ? -1 : b === root ? 1 : compare(a, b),
  );
  for (const id of ids) {
    const parent = parents.get(id);
    if (!parent) continue;
    const siblings = children.get(parent.from) ?? [];
    siblings.push(id);
    children.set(parent.from, siblings);
  }
  const stack = ids
    .filter((id) => !parents.has(id))
    .reverse()
    .map((id) => ({ id, depth: 0 }));
  const rows: ReturnType<typeof executionFlowRows> = [];
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    rows.push({
      node: retained.get(id)!,
      depth,
      parent: parents.get(id),
      relationships: outgoing.get(id) ?? [],
      runs: retainedRuns.get(id) ?? [],
    });
    for (const child of [...(children.get(id) ?? [])].reverse())
      stack.push({ id: child, depth: depth + 1 });
  }
  return rows;
}
