import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  attachWorkspaceFileToThread,
  currentTurnFilesInstruction,
  materializeCurrentTurnFiles,
} from "./thread-artifacts.js";

describe("current-turn thread files", () => {
  it("removes stored bytes when artifact metadata cannot be created", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const failure = new Error("database unavailable");

    await expect(
      attachWorkspaceFileToThread(
        {
          prisma: {
            artifact: { create: vi.fn().mockRejectedValue(failure) },
          } as unknown as PrismaClient,
          artifacts: {
            put: vi.fn().mockResolvedValue({ id: "stored-1", hash: "hash" }),
            remove,
          } as unknown as ArtifactStore,
        },
        {
          spaceId: "workspace-1",
          userId: "user-1",
          botId: "bot-1",
          runId: "run-1",
          filePath: "report.pdf",
          bytes: new Uint8Array([1, 2, 3]),
          operationId: "attach-1",
        },
      ),
    ).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledWith(
      "stored-1",
      expect.objectContaining({ spaceId: "workspace-1", botId: "bot-1" }),
    );
  });

  it.each([
    { kind: "file" as const, mimeType: "application/pdf", extension: "pdf" },
    { kind: "image" as const, mimeType: "image/png", extension: "png" },
  ])(
    "copies $kind attachments into the authorized bot workspace",
    async ({ kind, mimeType, extension }) => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: "artifact-1",
          spaceId: "workspace-1",
          botId: "bot-1",
          name: `../quarterly report.${extension}`,
          mimeType,
          size: 4,
          storageKey: "stored-1",
        },
      ]);
      const get = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
      const writeFile = vi.fn().mockResolvedValue(undefined);
      const markWorkspaceDirty = vi.fn();
      const context: AdapterContext & { botId: string } = {
        operationId: "run-1",
        traceId: "run-1",
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      };
      const computer: ComputerRef = {
        id: "computer-1",
        botId: "bot-1",
        kind: "fake",
        providerRef: "fake-1",
      };
      const blocks: MessageBlock[] = [
        {
          kind,
          artifactId: "artifact-1",
          name: `../quarterly report.${extension}`,
          mimeType,
          size: 4,
        },
      ];

      const files = await materializeCurrentTurnFiles(
        {
          prisma: { artifact: { findMany } } as unknown as PrismaClient,
          artifacts: { get } as unknown as ArtifactStore,
          sandbox: { writeFile } as unknown as SandboxProvider,
        },
        blocks,
        { context, computer, computerMode: "team", markWorkspaceDirty },
      );

      expect(findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["artifact-1"] },
          spaceId: context.spaceId,
          userId: context.userId,
        },
      });
      expect(get).toHaveBeenCalledWith("stored-1", context);
      expect(writeFile).toHaveBeenCalledWith(
        computer,
        {
          path: `bots/bot-1/attachments/artifact-1.${extension}`,
          content: new Uint8Array([1, 2, 3, 4]),
        },
        context,
      );
      expect(markWorkspaceDirty).toHaveBeenCalledOnce();
      expect(markWorkspaceDirty.mock.invocationCallOrder[0]).toBeLessThan(
        writeFile.mock.invocationCallOrder[0]!,
      );
      expect(files).toEqual([
        {
          name: `../quarterly report.${extension}`,
          mimeType,
          size: 4,
          path: `attachments/artifact-1.${extension}`,
        },
      ]);
      expect(currentTurnFilesInstruction(files)).toContain(
        JSON.stringify(`attachments/artifact-1.${extension}`),
      );
    },
  );

  it("does not query storage for turns without attachments", async () => {
    const findMany = vi.fn();
    const files = await materializeCurrentTurnFiles(
      {
        prisma: { artifact: { findMany } } as unknown as PrismaClient,
        artifacts: {} as ArtifactStore,
        sandbox: {} as SandboxProvider,
      },
      [{ kind: "text", text: "hello" }],
      {
        context: {
          operationId: "run-1",
          traceId: "run-1",
          spaceId: "workspace-1",
          userId: "user-1",
          botId: "bot-1",
          signal: new AbortController().signal,
        },
        computer: {
          id: "computer-1",
          botId: "bot-1",
          kind: "fake",
          providerRef: "fake-1",
        },
        computerMode: "team",
      },
    );

    expect(files).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
