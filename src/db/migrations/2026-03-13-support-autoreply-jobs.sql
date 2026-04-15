BEGIN;

CREATE TABLE IF NOT EXISTS support_auto_reply_jobs (
  id BIGSERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  channel VARCHAR(16) NOT NULL,
  recipient_email VARCHAR(320),
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(64),
  last_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_auto_jobs_poll
  ON support_auto_reply_jobs (status, run_after, id);

CREATE INDEX IF NOT EXISTS idx_support_auto_jobs_ticket
  ON support_auto_reply_jobs (ticket_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_support_auto_jobs_ticket_open
  ON support_auto_reply_jobs (ticket_id)
  WHERE status IN ('queued', 'processing', 'retry_wait');

CREATE TABLE IF NOT EXISTS support_email_deliveries (
  id BIGSERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  job_id BIGINT REFERENCES support_auto_reply_jobs(id) ON DELETE SET NULL,
  recipient_email VARCHAR(320) NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'sendgrid_smtp',
  provider_message_id TEXT,
  send_status VARCHAR(24) NOT NULL,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_email_deliveries_ticket
  ON support_email_deliveries (ticket_id, created_at DESC);

COMMIT;
