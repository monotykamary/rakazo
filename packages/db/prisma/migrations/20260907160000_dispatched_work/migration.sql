ALTER TABLE "bots" ADD COLUMN "temporary" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "dispatched_work" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "parentBotId" TEXT NOT NULL,
  "parentThreadId" TEXT NOT NULL,
  "parentRunId" TEXT NOT NULL,
  "workerBotId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "computerId" TEXT NOT NULL,
  "homeKey" TEXT NOT NULL,
  "projectPath" TEXT NOT NULL,
  "worktreePath" TEXT,
  "tools" TEXT[] NOT NULL,
  "requestKey" TEXT NOT NULL,
  "leaseFence" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dispatched_work_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dispatched_work_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "dispatched_work_workerBotId_key" ON "dispatched_work"("workerBotId");
CREATE UNIQUE INDEX "dispatched_work_taskId_key" ON "dispatched_work"("taskId");
CREATE UNIQUE INDEX "dispatched_work_runId_key" ON "dispatched_work"("runId");
CREATE UNIQUE INDEX "dispatched_work_spaceId_requestKey_key" ON "dispatched_work"("spaceId", "requestKey");
CREATE INDEX "dispatched_work_computerId_createdAt_id_idx" ON "dispatched_work"("computerId", "createdAt", "id");
CREATE INDEX "dispatched_work_spaceId_parentBotId_createdAt_idx" ON "dispatched_work"("spaceId", "parentBotId", "createdAt");
