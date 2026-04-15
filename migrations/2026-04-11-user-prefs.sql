-- =====================================================================
-- 2026-04-11 — user_prefs + privacy request tables
-- Target DB: PostgreSQL (main yua_ai, port 5432)
-- Apply:  PGPASSWORD=... psql -h 127.0.0.1 -U yua -d yua_ai \
--          -f yua-backend/migrations/2026-04-11-user-prefs.sql
-- Re-runnable via IF NOT EXISTS.
-- Scope: Settings v2 — user-scoped prefs + GDPR-style request log.
-- user_id is a plain INTEGER (users live partly in MySQL; same convention
-- as billing/usage tables — no FK).
-- =====================================================================

-- 1) user_prefs — JSONB bag for non-persona UX preferences.
--    Whitelisted keys enforced at the controller layer (see
--    src/control/user-prefs.controller.ts).
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    INTEGER PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) data_export_requests — user-initiated data export requests.
--    Actual export is async/manual for now — this just records intent.
CREATE TABLE IF NOT EXISTS data_export_requests (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_data_export_requests_user
  ON data_export_requests (user_id, requested_at DESC);

-- 3) data_delete_requests — user-initiated delete requests.
--    No destructive action happens here — just records intent.
CREATE TABLE IF NOT EXISTS data_delete_requests (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_data_delete_requests_user
  ON data_delete_requests (user_id, requested_at DESC);

-- =====================================================================
-- END 2026-04-11-user-prefs.sql
-- =====================================================================
