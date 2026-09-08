ALTER TABLE "user" ADD COLUMN "onboardedAt" TIMESTAMP(3);

UPDATE "user" AS u SET "onboardedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "bots" b WHERE b."userId" = u.id)
   OR EXISTS (SELECT 1 FROM "bot_deletions" d WHERE d."deletedByUserId" = u.id)
   OR EXISTS (SELECT 1 FROM "usage_records" r WHERE r."userId" = u.id);
