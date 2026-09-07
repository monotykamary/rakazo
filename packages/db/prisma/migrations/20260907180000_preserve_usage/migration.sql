-- Spend is historical, not bot lifecycle state. Keep botId for attribution via
-- bot_deletions.id; runs still cascade and their existing FK sets runId to NULL.
-- Space ownership and provider/model/token columns remain unchanged.
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_botId_fkey";
