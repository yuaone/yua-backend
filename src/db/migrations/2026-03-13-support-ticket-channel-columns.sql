BEGIN;

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS source_platform VARCHAR(16) NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS reporter_email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS client_app_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS client_os VARCHAR(32);

UPDATE support_tickets
SET source_platform = 'web'
WHERE source_platform IS NULL OR source_platform = '';

CREATE INDEX IF NOT EXISTS idx_support_tickets_source_platform
  ON support_tickets (source_platform, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_reporter_email
  ON support_tickets (reporter_email);

COMMIT;
