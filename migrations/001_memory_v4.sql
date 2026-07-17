-- Memory v4: provenance + reconciliation. Apply to a DB created before v4:
--   wrangler d1 execute grabber --remote --file migrations/001_memory_v4.sql
-- Fresh databases get these columns from schema.sql and should NOT run this.
--
-- (`category` and `embedding` reached prod as hand-run ALTERs during v2/v3 and were
-- never written back to schema.sql. They are in schema.sql now; this file assumes
-- a DB that already has them, which is what prod is.)

ALTER TABLE memories ADD COLUMN updated_at TEXT;
ALTER TABLE memories ADD COLUMN source     TEXT DEFAULT 'chat';  -- chat | auto | backfill
ALTER TABLE memories ADD COLUMN context    TEXT;                 -- exchange it was learned from

UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE memories SET source = 'chat' WHERE source IS NULL;
