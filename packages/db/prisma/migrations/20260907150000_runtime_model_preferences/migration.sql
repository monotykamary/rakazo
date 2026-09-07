CREATE TABLE "runtime_model_preferences" (
  "spaceId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "selection" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "runtime_model_preferences_pkey" PRIMARY KEY ("spaceId", "threadId", "botId", "participantId"),
  CONSTRAINT "runtime_model_preferences_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "runtime_model_preferences_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
