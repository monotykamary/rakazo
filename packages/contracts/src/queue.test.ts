import { expect, it } from "vitest";
import { QueueMutationSchema } from "./queue.js";
import { appContract } from "./rpc.js";

it("accepts drain only as a server-selected revisioned operation", () => {
  const input = {
    threadId: "thread",
    botId: "bot",
    requestId: "drain",
    expectedRevision: 1,
    operation: { type: "drain" },
  };
  expect(QueueMutationSchema.safeParse(input).success).toBe(true);
  expect(
    QueueMutationSchema.safeParse({ ...input, operation: { type: "drain", rowIds: ["skip"] } })
      .success,
  ).toBe(false);
});

it("registers public queue and execution endpoints", () => {
  expect(appContract.queue.list).toBeDefined();
  expect(appContract.queue.mutate).toBeDefined();
  expect(appContract.execution.inspect).toBeDefined();
});
it("accepts a child target but no client-selected session or cross-scope target", () => {
  const input = {
    threadId: "thread",
    botId: "bot",
    requestId: "target",
    expectedRevision: 0,
    operation: { type: "enqueue", lane: "steer", text: "help", target: { participantId: "child" } },
  };
  expect(QueueMutationSchema.safeParse(input).success).toBe(true);
  for (const extra of [
    { botId: "other" },
    { threadId: "other" },
    { generation: 4 },
    { cwd: "/host" },
  ]) {
    expect(
      QueueMutationSchema.safeParse({
        ...input,
        operation: { ...input.operation, target: { ...input.operation.target, ...extra } },
      }).success,
    ).toBe(false);
  }
});
it("placement recovery accepts only a row identity, never a client cwd", () => {
  const input = {
    threadId: "thread",
    botId: "bot",
    requestId: "bind",
    expectedRevision: 0,
    operation: { type: "bind-placement", id: "row" },
  };
  expect(QueueMutationSchema.safeParse(input).success).toBe(true);
  expect(
    QueueMutationSchema.safeParse({ ...input, operation: { ...input.operation, cwd: "/host" } })
      .success,
  ).toBe(false);
});
it("requires revisions and bounds mutation attachments", () => {
  const input = {
    threadId: "thread",
    botId: "bot",
    requestId: "request",
    expectedRevision: 0,
    operation: { type: "enqueue", lane: "steer", text: "hello" },
  };
  expect(QueueMutationSchema.safeParse(input).success).toBe(true);
  expect(QueueMutationSchema.safeParse({ ...input, expectedRevision: undefined }).success).toBe(
    false,
  );
  expect(
    QueueMutationSchema.safeParse({
      ...input,
      operation: {
        ...input.operation,
        images: [{ type: "image", mimeType: "text/html", data: "bad" }],
      },
    }).success,
  ).toBe(false);
});
