import type { ExecutionFlow, ExecutionFlowEdge, ExecutionFlowNode } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { executionFlowRows } from "./execution-flow-presentation.js";

const node = (
  id: string,
  kind: ExecutionFlowNode["kind"] = "run",
  runId?: string,
): ExecutionFlowNode => ({ id, kind, runId, evidence: [{ kind: "event", id }] });
const edge = (
  from: string,
  to: string,
  kind: ExecutionFlowEdge["kind"] = "contains",
  id = `${from}-${to}`,
): ExecutionFlowEdge => ({ id, from, to, kind, evidence: [{ kind: "event", id }] });
const flow = (nodes: ExecutionFlowNode[], edges: ExecutionFlowEdge[] = []): ExecutionFlow => ({
  nodes,
  edges,
  hasMoreRelatedRuns: true,
});

describe("executionFlowRows", () => {
  it.each(["owned", "bridge"] as const)("keeps explicit artifacts on %s messages", (route) => {
    for (const artifact of [{ code: "return 1;" }, { name: "Review notes" }]) {
      const input = flow(
        [
          node("a", "run", "a"),
          node("b"),
          { ...node("m", "message", route === "owned" ? "a" : undefined), ...artifact },
        ],
        [edge("a", "m", route === "owned" ? "contains" : "messages"), edge("m", "b", "starts")],
      );
      expect(executionFlowRows(input).find((row) => row.node.id === "m")?.node).toMatchObject(
        artifact,
      );
    }
  });
  it("keeps opaque bridge identifiers distinct", () => {
    const input = flow(
      [node("a"), node("b"), node("c"), node("m", "message"), node("n", "message")],
      [
        edge("a", "m", "messages", "x:y"),
        edge("m", "b", "starts", "z"),
        edge("a", "n", "messages", "x"),
        edge("n", "c", "starts", "y:z"),
      ],
    );
    const links = executionFlowRows(input).find((row) => row.node.id === "a")!.relationships;
    expect(links).toHaveLength(2);
    expect(new Set(links.map((link) => link.id)).size).toBe(2);
  });
  it("groups only bot identities, preserves every run and prefers authorized names", () => {
    const a = { ...node("run:a", "run", "a"), botId: "chief", name: "Chief", status: "completed" };
    const b = { ...node("run:b", "run", "b"), botId: "chief", name: "Chief", status: "running" };
    const alias = { ...node("alias", "participant"), botId: "chief", name: "Stale" };
    const peer = { ...node("peer"), botId: "other", name: "Chief" };
    const fabric = {
      ...node("fabric", "participant"),
      participantId: "child",
      botId: "chief",
      name: "Chief",
    };
    const input = flow(
      [a, b, alias, peer, fabric, node("unknown"), node("tool", "execution")],
      [edge("run:b", "tool"), edge("alias", "run:a"), edge("run:a", "run:a", "messages")],
    );
    const rows = executionFlowRows(input, "b");
    expect(rows[0]).toMatchObject({
      node: { id: "bot:chief", kind: "participant", name: "Chief" },
      runs: [a, b],
      depth: 0,
    });
    expect(rows[0]!.node.runId).toBeUndefined();
    expect(rows[0]!.node.status).toBeUndefined();
    expect(rows[0]!.node.evidence.map((item) => item.id)).toEqual([
      "alias",
      "alias-run:a",
      "run:a",
      "run:b",
    ]);
    expect(rows[0]!.relationships.some((link) => link.from === link.to)).toBe(true);
    expect(rows.find((row) => row.node.id === "tool")!.parent?.from).toBe("bot:chief");
    expect(rows.map((row) => row.node.id)).toEqual(
      expect.arrayContaining(["bot:other", "fabric", "unknown"]),
    );
    expect(executionFlowRows(flow([a, alias]))[0]).toMatchObject({
      node: { runId: "a", status: "completed" },
      runs: [a],
    });
  });
  it("bypasses proven bridges with all evidence and keeps ambiguous partial routes", () => {
    const input = flow(
      [node("a", "participant"), node("b"), node("m", "message")],
      [
        edge("a", "m", "messages"),
        edge("m", "b", "starts"),
        edge("a", "b", "messages", "duplicate"),
      ],
    );
    const rows = executionFlowRows(input);
    expect(rows.map((row) => row.node.id)).toEqual(["a", "b"]);
    expect(rows[0]!.relationships[0]).toMatchObject({ kind: "messages", from: "a", to: "b" });
    expect(rows[0]!.relationships[0]!.evidence.map((item) => item.id)).toEqual([
      "a-m",
      "duplicate",
      "m",
      "m-b",
    ]);
    expect(
      executionFlowRows({
        ...input,
        nodes: [...input.nodes, node("c")],
        edges: [...input.edges, edge("m", "c", "starts")],
      }),
    ).toHaveLength(4);
    expect(executionFlowRows(flow(input.nodes, [input.edges[0]!]))).toHaveLength(3);
  });
  it.each(["replies", "results"] as const)(
    "preserves %s bridge evidence without making it a layout parent",
    (kind) => {
      const input = flow(
        [node("a", "participant"), node("b", "participant"), node("m", "message")],
        [edge("a", "m", "messages"), edge("m", "b", kind)],
      );
      const rows = executionFlowRows(input);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.depth === 0)).toBe(true);
      expect(rows[0]!.relationships[0]).toMatchObject({ kind, from: "a", to: "b" });
      expect(rows[0]!.relationships[0]!.evidence.map((item) => item.id)).toEqual([
        "a-m",
        "m",
        "m-b",
      ]);
      const ambiguous = flow(
        [...input.nodes, node("c")],
        [...input.edges, edge("c", "m", "messages")],
      );
      expect(executionFlowRows(ambiguous)).toHaveLength(4);
      const self = flow(input.nodes, [...input.edges, edge("m", "m", "messages")]);
      expect(executionFlowRows(self)).toHaveLength(3);
    },
  );
  it("selects the requested identity as root across reciprocal messages deterministically", () => {
    const input = flow(
      [
        { ...node("a", "run", "a"), botId: "a" },
        { ...node("z", "run", "z"), botId: "z" },
      ],
      [edge("a", "z", "messages"), edge("z", "a", "messages"), edge("a", "z", "results")],
    );
    const rows = executionFlowRows(input, "z");
    expect(rows.map((row) => [row.node.id, row.depth])).toEqual([
      ["bot:z", 0],
      ["bot:a", 1],
    ]);
    expect(rows.flatMap((row) => row.relationships)).toHaveLength(3);
    expect(
      executionFlowRows(
        { ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() },
        "z",
      ),
    ).toEqual(rows);
  });
  it("contracts owned transport and unions inbound, outbound, duplicate and containment evidence", () => {
    const input = flow(
      [node("a"), node("b"), node("m", "message", "a")],
      [
        edge("a", "m"),
        edge("m", "b", "starts", "one"),
        edge("a", "b", "starts", "two"),
        edge("b", "m", "results"),
      ],
    );
    const before = structuredClone(input);
    const rows = executionFlowRows(input);
    expect(rows.map((row) => row.node.id)).toEqual(["a", "b"]);
    expect(rows[0]!.node.evidence.map((item) => item.id)).toEqual(["a", "a-m", "m"]);
    expect(rows[0]!.relationships).toHaveLength(1);
    expect(rows[0]!.relationships[0]).toMatchObject({
      id: "one",
      from: "a",
      to: "b",
      kind: "starts",
    });
    expect(rows[0]!.relationships[0]!.evidence.map((item) => item.id)).toEqual(["m", "one", "two"]);
    expect(rows[1]!.relationships[0]).toMatchObject({ from: "b", to: "a", kind: "results" });
    expect(rows[1]!.parent).toEqual(rows[0]!.relationships[0]);
    expect(input).toEqual(before);
  });
  it("retains ambiguous, unowned and absent-owner messages without guessing from names or pages", () => {
    const input = flow(
      [
        node("a"),
        node("b"),
        node("ambiguous", "message", "a"),
        node("unowned", "message"),
        node("absent", "message", "missing"),
        node("conflict", "message", "missing"),
      ],
      [edge("b", "ambiguous"), edge("unowned", "a", "starts"), edge("a", "conflict")],
    );
    expect(executionFlowRows(input)).toHaveLength(6);
  });
  it("uses recorded containment alone and retains distinct link semantics", () => {
    const rows = executionFlowRows(
      flow(
        [node("a"), node("b"), node("m", "message")],
        [edge("a", "m"), edge("m", "b", "messages"), edge("a", "b", "starts")],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.relationships.map((link) => link.kind)).toEqual(["starts", "messages"]);
  });
  it("prefers structural parents, bounds cycles, and preserves non-tree links and disconnected kinds", () => {
    const input = flow(
      [
        node("a"),
        node("b", "participant"),
        node("c", "execution"),
        node("wait", "wait"),
        node("recovery", "recovery"),
      ],
      [
        edge("a", "c"),
        edge("b", "c", "calls"),
        edge("a", "b", "delegates"),
        edge("c", "a", "results"),
      ],
    );
    const rows = executionFlowRows(input);
    expect(new Set(rows.map((row) => row.node.id)).size).toBe(5);
    expect(rows.find((row) => row.node.id === "c")).toMatchObject({
      depth: 2,
      parent: { from: "b", kind: "calls" },
    });
    expect(rows.flatMap((row) => row.relationships)).toHaveLength(4);
    expect(
      rows
        .filter((row) => ["wait", "recovery"].includes(row.node.id))
        .every((row) => row.depth === 0),
    ).toBe(true);
    expect(
      executionFlowRows({
        ...input,
        nodes: [...input.nodes].reverse(),
        edges: [...input.edges].reverse(),
      }),
    ).toEqual(rows);
  });
  it("drops evidence-free nodes and dangling edges, but retains original self-links", () => {
    const rows = executionFlowRows(
      flow(
        [node("a"), node("b"), { ...node("empty"), evidence: [] }],
        [
          { ...edge("a", "b"), evidence: [] },
          edge("a", "missing"),
          edge("a", "empty"),
          edge("a", "a"),
        ],
      ),
    );
    expect(rows.map((row) => row.node.id)).toEqual(["a", "b"]);
    expect(rows.every((row) => row.depth === 0 && !row.parent)).toBe(true);
    expect(rows.flatMap((row) => row.relationships)).toEqual([edge("a", "a")]);
  });
  it("keeps original message self relationships after contraction and absorbs only new self-links", () => {
    const rows = executionFlowRows(
      flow(
        [node("a"), node("m", "message", "a"), node("n", "message", "a")],
        [edge("a", "m"), edge("m", "n", "replies"), edge("m", "m", "messages")],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parent).toBeUndefined();
    expect(rows[0]!.relationships).toEqual([
      {
        ...edge("m", "m", "messages"),
        from: "a",
        to: "a",
        evidence: [
          { kind: "event", id: "m" },
          { kind: "event", id: "m-m" },
        ],
      },
    ]);
    expect(rows[0]!.node.evidence.map((item) => item.id)).toEqual(["a", "a-m", "m", "m-n", "n"]);
  });
  it.each(["replies", "results"] as const)(
    "keeps %s inspectable without making an older run a child of its reply",
    (kind) => {
      const rows = executionFlowRows(
        flow(
          [node("older"), node("reply", "message"), node("continuation")],
          [edge("reply", "older", kind), edge("reply", "continuation", "continues")],
        ),
      );
      expect(rows.find((row) => row.node.id === "older")).toMatchObject({
        depth: 0,
        parent: undefined,
      });
      expect(rows.find((row) => row.node.id === "reply")!.relationships).toContainEqual(
        edge("reply", "older", kind),
      );
      expect(rows.find((row) => row.node.id === "continuation")!.parent?.from).toBe("reply");
    },
  );
  it("deduplicates repeated evidence and traverses deep graphs without recursion", () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => node(String(i)));
    const edges = nodes.slice(1).map((item, i) => edge(String(i), item.id, "calls"));
    const duplicate = edges[0]!;
    const rows = executionFlowRows(flow(nodes, [...edges, duplicate]));
    expect(rows).toHaveLength(2000);
    expect(rows.at(-1)!.depth).toBe(1999);
    expect(rows[0]!.relationships[0]!.evidence).toHaveLength(1);
  });
});
