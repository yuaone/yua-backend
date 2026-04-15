BEGIN;

-- ------------------------------------------------------------------
-- Phase 1: Core SaaS Admin foundation
-- ------------------------------------------------------------------

-- 1) Durable audit outbox for non-blocking audit export
CREATE TABLE IF NOT EXISTS audit_outbox (
  id BIGSERIAL PRIMARY KEY,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  action VARCHAR(128) NOT NULL,
  actor_admin_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  retry_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_audit_outbox_status_created
  ON audit_outbox (status, created_at);

-- 2) Idempotency key registry for financial/privileged actions
CREATE TABLE IF NOT EXISTS admin_idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  scope VARCHAR(64) NOT NULL,
  key_hash VARCHAR(128) NOT NULL,
  request_fingerprint VARCHAR(128) NOT NULL,
  response_code INT,
  response_body JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, key_hash)
);
CREATE INDEX IF NOT EXISTS idx_admin_idempotency_expires
  ON admin_idempotency_keys (expires_at);

-- 3) Hourly KPI snapshots
CREATE TABLE IF NOT EXISTS admin_kpi_hourly (
  id BIGSERIAL PRIMARY KEY,
  bucket_at TIMESTAMPTZ NOT NULL,
  dau INT NOT NULL DEFAULT 0,
  mau INT NOT NULL DEFAULT 0,
  new_users INT NOT NULL DEFAULT 0,
  active_workspaces INT NOT NULL DEFAULT 0,
  total_requests BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  api_success_rate NUMERIC(5,2) NOT NULL DEFAULT 100.00,
  stream_interrupt_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  mrr NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  refund_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bucket_at)
);
CREATE INDEX IF NOT EXISTS idx_admin_kpi_hourly_bucket
  ON admin_kpi_hourly (bucket_at DESC);

-- 4) Daily KPI snapshots
CREATE TABLE IF NOT EXISTS admin_kpi_daily (
  id BIGSERIAL PRIMARY KEY,
  day DATE NOT NULL,
  dau INT NOT NULL DEFAULT 0,
  mau INT NOT NULL DEFAULT 0,
  new_users INT NOT NULL DEFAULT 0,
  active_workspaces INT NOT NULL DEFAULT 0,
  total_requests BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  api_success_rate NUMERIC(5,2) NOT NULL DEFAULT 100.00,
  stream_interrupt_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  mrr NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  refund_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day)
);
CREATE INDEX IF NOT EXISTS idx_admin_kpi_daily_day
  ON admin_kpi_daily (day DESC);

-- 5) Billing verification trace (web/app store/server side)
CREATE TABLE IF NOT EXISTS billing_verification_log (
  id BIGSERIAL PRIMARY KEY,
  platform VARCHAR(32) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  product_type VARCHAR(32),
  product_id VARCHAR(255),
  order_id VARCHAR(255),
  purchase_token VARCHAR(512),
  user_id BIGINT,
  workspace_id BIGINT,
  verification_status VARCHAR(32) NOT NULL,
  reason_code VARCHAR(64),
  latency_ms INT,
  raw_request JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_verification_created
  ON billing_verification_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_verification_order
  ON billing_verification_log (provider, order_id);
CREATE INDEX IF NOT EXISTS idx_billing_verification_token
  ON billing_verification_log (provider, purchase_token);

-- 6) Canonical credit ledger
CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT,
  user_id BIGINT NOT NULL,
  direction VARCHAR(8) NOT NULL CHECK (direction IN ('credit', 'debit')),
  reason VARCHAR(64) NOT NULL,
  amount NUMERIC(14,4) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(14,4),
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  source_type VARCHAR(32),
  source_id VARCHAR(255),
  idempotency_key VARCHAR(255) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_admin_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created
  ON credit_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_workspace_created
  ON credit_ledger (workspace_id, created_at DESC);

-- 7) Daily usage summary
CREATE TABLE IF NOT EXISTS usage_daily_summary (
  id BIGSERIAL PRIMARY KEY,
  day DATE NOT NULL,
  platform VARCHAR(16) NOT NULL,
  workspace_id BIGINT,
  user_id BIGINT,
  requests_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  stream_interrupt_count BIGINT NOT NULL DEFAULT 0,
  blocked_count BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(14,4) NOT NULL DEFAULT 0,
  revenue_usd NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day, platform, workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day
  ON usage_daily_summary (day DESC);

-- 8) Monthly usage summary
CREATE TABLE IF NOT EXISTS usage_monthly_summary (
  id BIGSERIAL PRIMARY KEY,
  month DATE NOT NULL,
  platform VARCHAR(16) NOT NULL,
  workspace_id BIGINT,
  user_id BIGINT,
  requests_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  stream_interrupt_count BIGINT NOT NULL DEFAULT 0,
  blocked_count BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(14,4) NOT NULL DEFAULT 0,
  revenue_usd NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (month, platform, workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_month
  ON usage_monthly_summary (month DESC);

COMMIT;

