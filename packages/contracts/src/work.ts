import { z } from "zod";
import { Id, RunStatus } from "./ids.js";
import { ModelSelectionSchema } from "./model-selection.js";

export const WorkProjectPath = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !path.split("/").includes(".."),
    "Use a workspace-relative project path",
  );
export const WorkToolName = z.enum([
  "read_file",
  "list_files",
  "write_file",
  "edit_file",
  "attach_file",
]);
export const DispatchWorkInput = z
  .object({
    task: z.string().trim().min(1).max(8000),
    name: z.string().trim().min(1).max(80).default("Worker"),
    instructions: z.string().trim().max(12000).default(""),
    project_path: WorkProjectPath,
    worktree_path: WorkProjectPath.optional(),
    model: ModelSelectionSchema.optional(),
    tools: z
      .array(WorkToolName)
      .min(1)
      .max(5)
      .default(["read_file", "list_files", "write_file", "edit_file"]),
  })
  .strict();
export type DispatchWorkInput = z.infer<typeof DispatchWorkInput>;

export const WorkReceiptSchema = z.object({
  id: Id,
  taskId: Id,
  runId: Id,
  threadId: Id,
  workerId: Id,
  name: z.string(),
  projectPath: z.string(),
  worktreePath: z.string().nullable(),
  status: RunStatus,
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type WorkReceipt = z.infer<typeof WorkReceiptSchema>;
export const WorkLinkSchema = WorkReceiptSchema.pick({
  id: true,
  taskId: true,
  runId: true,
  threadId: true,
  workerId: true,
  name: true,
  projectPath: true,
  worktreePath: true,
});
export type WorkLink = z.infer<typeof WorkLinkSchema>;
