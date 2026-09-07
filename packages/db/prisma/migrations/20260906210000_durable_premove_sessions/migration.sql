CREATE TABLE "runtime_sessions" (
  "spaceId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "generation" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "state" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("spaceId", "threadId", "botId")
);
CREATE TABLE "premove_queues" (
  "spaceId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "state" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("spaceId", "threadId", "botId")
);
