CREATE TABLE "office_egress_preferences" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "office_egress_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "office_egress_preferences_spaceId_userId_key"
  ON "office_egress_preferences"("spaceId", "userId");
