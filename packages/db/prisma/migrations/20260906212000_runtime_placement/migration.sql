CREATE TABLE "runtime_placements" (
  "spaceId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "computerId" TEXT NOT NULL,
  "homeKey" TEXT NOT NULL,
  "projectPath" TEXT NOT NULL,
  "worktreePath" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("spaceId", "threadId", "botId")
);
