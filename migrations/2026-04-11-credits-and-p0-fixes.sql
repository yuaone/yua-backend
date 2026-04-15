-- =====================================================================
-- 2026-04-11 — Credit system (LemonSqueezy overage top-up) + P0 fixes
-- Target DB: PostgreSQL (main yua_ai, port 5432)
-- Apply manually:   psql -h 127.0.0.1 -U yua -d yua_ai -f this-file.sql
-- Re-runnable:      uses IF NOT EXISTS on every CREATE
-- Scope:            2 new tables (user_credits, user_credit_ledger)
-- Naming note:      `credit_transactions` already exists in this DB for a
--                   legacy API-key credit system (api_key_id scoped).
--                   We use `user_credit_ledger` to avoid collision and to
--                   make the scope explicit (user-level, Settings v2).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) user_credits — per-user credit balance (fast read for gate)
--    Owner: usage-gate bypass check + webhook order_created grant
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_credits (
  user_id                    BIGINT PRIMARY KEY,
  balance_usd_cents          BIGINT  NOT NULL DEFAULT 0,
  auto_topup_enabled         BOOLEAN NOT NULL DEFAULT false,
  auto_topup_amount_cents    BIGINT,
  auto_topup_threshold_cents BIGINT,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_credits_balance_nonneg CHECK (balance_usd_cents >= 0)
);

-- ---------------------------------------------------------------------
-- 2) user_credit_ledger — append-only audit log
--    types: 'purchase' | 'grant_admin' | 'grant_promo'
--         | 'consume'  | 'refund'      | 'expire'
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_credit_ledger (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL,
  type                 TEXT   NOT NULL,
  amount_cents         BIGINT NOT NULL,       -- signed: +credit, -debit
  balance_after_cents  BIGINT NOT NULL,
  ref_type             TEXT,                  -- 'ls_order' | 'usage_log_id' | 'admin'
  ref_id               TEXT,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_credit_ledger_user
  ON user_credit_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_credit_ledger_type
  ON user_credit_ledger (type, created_at DESC);

-- Prevent duplicate purchase entries when webhook retries — keyed by LS order id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_credit_ledger_ls_order_unique
  ON user_credit_ledger (ref_id)
  WHERE ref_type = 'ls_order' AND type = 'purchase';

-- =====================================================================
-- END 2026-04-11-credits-and-p0-fixes.sql
-- =====================================================================
