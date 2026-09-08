CREATE TABLE "machines" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "pairingCodeHash" TEXT,
  "pairingExpiresAt" TIMESTAMP(3),
  "credentialHash" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "version" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "machines_spaceId_userId_updatedAt_idx" ON "machines"("spaceId", "userId", "updatedAt");
CREATE INDEX "machines_pairingCodeHash_idx" ON "machines"("pairingCodeHash");
CREATE INDEX "machines_credentialHash_idx" ON "machines"("credentialHash");

CREATE TABLE "machine_commands" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL REFERENCES "machines"("id") ON DELETE CASCADE,
  "method" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "query" TEXT NOT NULL DEFAULT '',
  "bodyBase64" TEXT,
  "contentType" TEXT,
  "headersJson" TEXT NOT NULL DEFAULT '{}',
  "scopeKind" TEXT NOT NULL,
  "scopeSpaceId" TEXT,
  "scopeRunId" TEXT,
  "scopeBotId" TEXT,
  "scopeComputerId" TEXT,
  "scopeLeaseOwner" TEXT,
  "scopeLeaseFence" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "responseStatus" INTEGER,
  "responseContentType" TEXT,
  "responseBodyBase64" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "machine_commands_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "machine_commands_machineId_status_createdAt_idx"
  ON "machine_commands"("machineId", "status", "createdAt");
CREATE INDEX "machine_commands_expiresAt_idx" ON "machine_commands"("expiresAt");

ALTER TABLE "computers" ADD COLUMN "machineId" TEXT;
CREATE INDEX "computers_machineId_idx" ON "computers"("machineId");
ALTER TABLE "computers" ADD CONSTRAINT "computers_machineId_fkey"
  FOREIGN KEY ("machineId") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
