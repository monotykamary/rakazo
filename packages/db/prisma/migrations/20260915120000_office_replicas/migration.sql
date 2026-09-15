CREATE TABLE "office_replicas" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "epoch" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'handing_off',
  "journalCursor" INTEGER NOT NULL DEFAULT -1,
  "journalHead" TEXT NOT NULL DEFAULT '',
  "leaseFence" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "handedOffAt" TIMESTAMP(3),
  "lastJournalAt" TIMESTAMP(3),
  "importedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "office_replicas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "office_replicas_runId_key" ON "office_replicas"("runId");
CREATE INDEX "office_replicas_machineId_status_idx" ON "office_replicas"("machineId", "status");
CREATE INDEX "office_replicas_status_updatedAt_id_idx" ON "office_replicas"("status", "updatedAt", "id");

ALTER TABLE "office_replicas"
  ADD CONSTRAINT "office_replicas_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "office_replicas"
  ADD CONSTRAINT "office_replicas_machineId_fkey"
  FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
