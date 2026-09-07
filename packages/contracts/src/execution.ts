import * as z from "zod";
import { ProductEventSchema } from "./events.js";
import { Id } from "./ids.js";

export const ExecutionInspectInputSchema = z.object({
  runId: Id,
  afterSeq: z.number().int().min(-1).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export const FlowEvidenceSchema = z.object({ kind: z.enum(["event", "run", "message"]), id: Id });
export const ExecutionFlowNodeSchema = z.object({
  id: Id,
  kind: z.enum(["run", "execution", "participant", "message", "wait", "recovery"]),
  runId: Id.optional(),
  botId: Id.optional(),
  executionId: Id.optional(),
  participantId: Id.optional(),
  messageId: Id.optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  code: z.string().optional(),
  evidence: z.array(FlowEvidenceSchema),
});
export const ExecutionFlowEdgeSchema = z.object({
  id: Id,
  from: Id,
  to: Id,
  kind: z.enum([
    "contains",
    "calls",
    "delegates",
    "waits-for",
    "continues",
    "starts",
    "results",
    "messages",
    "replies",
  ]),
  evidence: z.array(FlowEvidenceSchema),
});
export const ExecutionFlowSchema = z.object({
  nodes: z.array(ExecutionFlowNodeSchema),
  edges: z.array(ExecutionFlowEdgeSchema),
  hasMoreRelatedRuns: z.boolean().default(false),
});
export type ExecutionFlow = z.infer<typeof ExecutionFlowSchema>;
export type ExecutionFlowNode = z.infer<typeof ExecutionFlowNodeSchema>;
export type ExecutionFlowEdge = z.infer<typeof ExecutionFlowEdgeSchema>;

export const ExecutionInspectionSchema = z.object({
  runId: Id,
  events: z.array(ProductEventSchema),
  nextCursor: z.number().int().min(-1),
  hasMore: z.boolean(),
  flow: ExecutionFlowSchema,
  participants: z.array(
    z.object({ botId: Id, participantId: Id.optional(), name: z.string().optional() }),
  ),
});
export type ExecutionInspection = z.infer<typeof ExecutionInspectionSchema>;
