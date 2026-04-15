-- YUAN Coding Agent Tables Migration
-- YUA Platform — YUAN Agent (Phase 1 MVP)
-- Run: cat yuan-agent-tables.sql | psql -h 127.0.0.1 -U postgres -d yua_ai

BEGIN;

-- =============================================================
-- agent_sessions — one row per agent invocation
-- =============================================================
CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL,
  workspace_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'initializing',
    -- initializing | running | waiting_approval | paused | completed | failed | stopped
  prompt TEXT NOT NULL,
  model VARCHAR(100) NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  provider VARCHAR(20) NOT NULL DEFAULT 'anthropic',
  plan VARCHAR(20) NOT NULL DEFAULT 'free',
  work_dir VARCHAR(500),
  max_iterations INTEGER NOT NULL DEFAULT 25,
  iterations_completed INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  files_changed JSONB DEFAULT '[]',
  config JSONB DEFAULT '{}',
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_user
  ON agent_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace
  ON agent_sessions (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status
  ON agent_sessions (status);

-- =============================================================
-- agent_iterations — one row per LLM round-trip iteration
-- Columns match AgentExecutor.persistIteration() in agent-executor.ts
-- =============================================================
CREATE TABLE IF NOT EXISTS agent_iterations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  iteration_number INTEGER NOT NULL,
  content JSONB,
  tool_calls JSONB,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_iterations_id
  ON agent_iterations (id);
CREATE INDEX IF NOT EXISTS idx_agent_iterations_session
  ON agent_iterations (session_id, iteration_number);

-- =============================================================
-- agent_events — append-only SSE event log for replay/audit
-- =============================================================
CREATE TABLE IF NOT EXISTS agent_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind VARCHAR(50) NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_session_seq
  ON agent_events (session_id, seq);

-- =============================================================
-- agent_approvals — human-in-the-loop approval requests
-- =============================================================
CREATE TABLE IF NOT EXISTS agent_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  action_type VARCHAR(30) NOT NULL,
  description TEXT NOT NULL,
  details JSONB,
  risk VARCHAR(10) NOT NULL DEFAULT 'medium',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending | approved | rejected | timeout
  responded_by INTEGER,
  responded_at TIMESTAMPTZ,
  timeout_ms INTEGER NOT NULL DEFAULT 120000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_approvals_session
  ON agent_approvals (session_id, status);

-- =============================================================
-- agent_checkpoints — crash recovery / context save
-- Columns match AgentExecutor.saveCheckpoint() in agent-executor.ts
-- =============================================================
CREATE TABLE IF NOT EXISTS agent_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  run_id UUID NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  messages JSONB,
  token_usage JSONB,
  reason VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session
  ON agent_checkpoints (session_id, created_at DESC);

COMMIT;
