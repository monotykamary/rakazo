CREATE TABLE "office_move_intents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "effectKey" TEXT NOT NULL,
  "claimToken" TEXT,
  "currentComputerId" TEXT,
  "machineId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "resultComputerId" TEXT,
  "error" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "office_move_intents_effectKey_key" ON "office_move_intents"("effectKey");
CREATE INDEX "office_move_intents_status_nextAttemptAt_id_idx" ON "office_move_intents"("status", "nextAttemptAt", "id");
CREATE INDEX "office_move_intents_spaceId_userId_botId_createdAt_idx" ON "office_move_intents"("spaceId", "userId", "botId", "createdAt");

ALTER TABLE "bots" ADD COLUMN "officeMoveIntentId" TEXT;
