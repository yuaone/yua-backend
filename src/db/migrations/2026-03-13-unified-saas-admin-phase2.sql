BEGIN;

-- ------------------------------------------------------------------
-- Phase 2/3: Safety, Release Control, Governance, Incident Ops
-- ------------------------------------------------------------------

-- 1) Incident timeline for SEV tracking and postmortems
CREATE TABLE IF NOT EXISTS incident_timeline (
  id BIGSERIAL PRIMARY KEY,
  incident_key VARCHAR(64) NOT NULL,
  severity VARCHAR(8) NOT NULL CHECK (severity IN ('SEV1', 'SEV2', 'SEV3')),
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  title VARCHAR(255) NOT NULL,
  description TEXT,
  affected_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  mitigated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  owner_admin_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_timeline_key
  ON incident_timeline (incident_key);
CREATE INDEX IF NOT EXISTS idx_incident_timeline_status_started
  ON incident_timeline (status, started_at DESC);

-- 2) Feature flags registry
CREATE TABLE IF NOT EXISTS feature_flags (
  id BIGSERIAL PRIMARY KEY,
  flag_key VARCHAR(120) NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  rollout_percent INT NOT NULL DEFAULT 0 CHECK (rollout_percent >= 0 AND rollout_percent <= 100),
  target_platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
  targeting_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by_admin_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flag_key)
);

-- 3) Feature flag audit trail
CREATE TABLE IF NOT EXISTS feature_flag_audit (
  id BIGSERIAL PRIMARY KEY,
  flag_key VARCHAR(120) NOT NULL,
  action VARCHAR(64) NOT NULL,
  before_value JSONB,
  after_value JSONB,
  reason TEXT,
  actor_admin_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feature_flag_audit_flag_created
  ON feature_flag_audit (flag_key, created_at DESC);

-- 4) Trust/Safety security events
CREATE TABLE IF NOT EXISTS security_event_log (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  risk_level VARCHAR(16) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  user_id BIGINT,
  workspace_id BIGINT,
  source_platform VARCHAR(16),
  signal JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision VARCHAR(32),
  action_taken VARCHAR(64),
  trace_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_security_event_risk_created
  ON security_event_log (risk_level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_event_user_created
  ON security_event_log (user_id, created_at DESC);

-- 5) Data subject requests (export/delete)
CREATE TABLE IF NOT EXISTS data_subject_request (
  id BIGSERIAL PRIMARY KEY,
  request_type VARCHAR(16) NOT NULL CHECK (request_type IN ('export', 'delete')),
  status VARCHAR(24) NOT NULL DEFAULT 'requested',
  user_id BIGINT NOT NULL,
  workspace_id BIGINT,
  requester_email VARCHAR(255),
  legal_basis VARCHAR(64),
  due_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  exported_artifact_url TEXT,
  notes TEXT,
  handled_by_admin_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_subject_request_status_due
  ON data_subject_request (status, due_at);
CREATE INDEX IF NOT EXISTS idx_data_subject_request_user_created
  ON data_subject_request (user_id, created_at DESC);

COMMIT;

