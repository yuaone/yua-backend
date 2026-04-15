-- =====================================================================
-- 2026-04-11 — Billing (LemonSqueezy) + Settings v2 schema
-- Target DB: PostgreSQL (main yua_ai, port 5432)
-- Apply manually:   psql -h 127.0.0.1 -U <user> -d yua_ai -f this-file.sql
-- Re-runnable:      uses IF NOT EXISTS on every CREATE
-- Scope:            8 new tables (no MySQL changes)
-- Note:             No FK to users/workspaces — users live in MySQL,
--                   so user_id / workspace_id are plain BIGINT columns,
--                   following existing yua-backend convention.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) billing_subscriptions — LemonSqueezy subscription mirror
--    Owner: Agent E (webhook handler / billing router)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL,
  workspace_id            BIGINT,
  provider                TEXT NOT NULL DEFAULT 'lemonsqueezy',
  ls_subscription_id      TEXT,
  ls_customer_id          TEXT,
  ls_variant_id           TEXT,
  ls_order_id             TEXT,
  plan_tier               TEXT NOT NULL,
  status                  TEXT NOT NULL,
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT false,
  update_url              TEXT,
  cancel_url              TEXT,
  trial_ends_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_sub_ls_id
  ON billing_subscriptions (ls_subscription_id)
  WHERE ls_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_sub_user_status
  ON billing_subscriptions (user_id, status);

-- ---------------------------------------------------------------------
-- 2) billing_events — raw webhook event log (idempotency by ls_event_id)
--    Owner: Agent E
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_events (
  id              BIGSERIAL PRIMARY KEY,
  ls_event_id     TEXT UNIQUE NOT NULL,
  event_name      TEXT NOT NULL,
  user_id         BIGINT,
  subscription_id BIGINT REFERENCES billing_subscriptions(id),
  payload         JSONB NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_event_name
  ON billing_events (event_name, processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_events_user
  ON billing_events (user_id, processed_at DESC);

-- ---------------------------------------------------------------------
-- 3) workspace_usage_log — per-message usage/cost log
--    Owner: Agent A (usage-recorder)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_usage_log (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     BIGINT NOT NULL,
  user_id          BIGINT NOT NULL,
  thread_id        BIGINT,
  message_id       BIGINT,
  model            TEXT NOT NULL,
  resolved         TEXT NOT NULL,
  input_tokens     INT NOT NULL DEFAULT 0,
  output_tokens    INT NOT NULL DEFAULT 0,
  cached_tokens    INT NOT NULL DEFAULT 0,
  reasoning_tokens INT NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(12, 8) NOT NULL,
  plan_tier        TEXT,
  compute_tier     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_log_user_created
  ON workspace_usage_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_log_workspace_created
  ON workspace_usage_log (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 4) user_usage_weekly — weekly aggregate for usage-gate
--    Owner: Agent A (weekly-tracker)
--    NOTE:  week_start_kst is DATE (calendar day — Monday in KST),
--           NOT TIMESTAMPTZ. It represents a day, not an instant.
--           Converting KST Monday to a UTC timestamp would cause
--           off-by-one bugs around midnight KST.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_usage_weekly (
  user_id        BIGINT NOT NULL,
  week_start_kst DATE   NOT NULL,
  messages       INT    NOT NULL DEFAULT 0,
  cost_usd       NUMERIC(12, 6) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, week_start_kst)
);

CREATE INDEX IF NOT EXISTS idx_usage_weekly_week
  ON user_usage_weekly (week_start_kst DESC);

-- ---------------------------------------------------------------------
-- 5) user_connectors — Phase 2 OAuth connector store (reserved)
--    Owner: (Phase 2 — no Phase 1 owner, table pre-created for forward compat)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_connectors (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL,
  provider       TEXT   NOT NULL,
  status         TEXT   NOT NULL,
  access_token   TEXT,
  refresh_token  TEXT,
  scopes         TEXT[],
  external_id    TEXT,
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_connectors_unique
  ON user_connectors (user_id, provider);

-- ---------------------------------------------------------------------
-- 6) user_billing_cap — monthly spend cap + auto-refresh flag
--    Owner: Agent A (spend cap check) + future Settings UI
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_billing_cap (
  user_id              BIGINT PRIMARY KEY,
  monthly_cap_usd      NUMERIC(10, 2),
  auto_refresh_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 7) user_sessions — active device sessions for Settings > Security
--    Owner: Agent B (session-registry)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
  session_id     TEXT PRIMARY KEY,
  user_id        BIGINT NOT NULL,
  device_label   TEXT,
  ip_address     INET,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON user_sessions (user_id, last_seen_at DESC);

-- ---------------------------------------------------------------------
-- 8) user_connector_interest — Phase 1 waitlist capture
--    Owner: Agent C (connectors-router Phase 1)
--    Purpose: data-driven Phase 2 prioritization
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_connector_interest (
  user_id     BIGINT NOT NULL,
  provider    TEXT   NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_interest_provider
  ON user_connector_interest (provider);

-- =====================================================================
-- END 2026-04-11-billing-and-settings.sql
-- =====================================================================
