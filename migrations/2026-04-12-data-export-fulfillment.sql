-- 📂 migrations/2026-04-12-data-export-fulfillment.sql
--
-- Phase F.1 — Data Export fulfillment pipeline
--
-- Expands `data_export_requests` (created earlier as a lightweight
-- intent-only ledger) into a full fulfillment flow:
--   pending → processing → ready → consumed / expired / failed
--
-- Download is gated by Firebase JWT (not HMAC) — the link emailed to
-- the user points at /settings/privacy?exportReady={id} which re-uses
-- the existing auth flow. Server enforces `user_id = req.user.id` on
-- every download hit, so leaking the numeric request id does NOT leak
-- the file.
--
-- Idempotent — safe to re-run (uses IF NOT EXISTS where applicable).

BEGIN;

-- Add fulfillment columns if missing.
ALTER TABLE data_export_requests
  ADD COLUMN IF NOT EXISTS status          TEXT        NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS file_path       TEXT,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS download_count  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS download_limit  INTEGER     NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_message   TEXT,
  ADD COLUMN IF NOT EXISTS locked_by       TEXT,
  ADD COLUMN IF NOT EXISTS locked_at       TIMESTAMPTZ;

-- CHECK constraint on status — guard against typos in worker code.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'data_export_requests_status_chk'
  ) THEN
    ALTER TABLE data_export_requests
      ADD CONSTRAINT data_export_requests_status_chk
      CHECK (status IN ('pending','processing','ready','consumed','expired','failed'));
  END IF;
END $$;

-- Worker polls this partial index to pick up pending rows cheaply.
CREATE INDEX IF NOT EXISTS idx_data_export_pending
  ON data_export_requests (status, requested_at)
  WHERE status = 'pending';

-- Cleanup cron scans this to find expired rows.
CREATE INDEX IF NOT EXISTS idx_data_export_expiring
  ON data_export_requests (expires_at)
  WHERE status = 'ready';

COMMIT;
