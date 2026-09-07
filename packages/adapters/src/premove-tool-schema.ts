import type { ConnectorTool } from "@rakazo/adapter-kit";
import { QueueOperationSchema } from "@rakazo/contracts";
import { z } from "zod";

export const PremoveToolInputSchema = z.object({
  operation: QueueOperationSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});
export const manageQueueTool: ConnectorTool = {
  name: "manage_queue",
  description:
    "Read or edit this bot's private premove queue when the user asks. Call with {} to read stable row IDs and revision; send operation and that expectedRevision to mutate. Use the shared FIFO lanes, holds, edit session, and pause/resume controls. Do not create unrequested work. Image data stays in the queue and is omitted from this view.",
  inputSchema: z.toJSONSchema(PremoveToolInputSchema),
};
