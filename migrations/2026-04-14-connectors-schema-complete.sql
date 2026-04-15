-- 2026-04-14: Complete connectors schema (idempotent — safe on existing prod DB)
-- Ensures fresh environments have all connector tables and columns.

-- 1. user_connectors: add columns that may be missing in older migrations
ALTER TABLE user_connectors ADD COLUMN IF NOT EXISTS server_url TEXT;
ALTER TABLE user_connectors ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE user_connectors ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'oauth';
ALTER TABLE user_connectors ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_connectors ADD COLUMN IF NOT EXISTS tool_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_connectors ADD COLUMN IF NOT EXISTS last_synced TIMESTAMPTZ;

-- 2. user_connector_tools: MCP tool inventory per user per connector
CREATE TABLE IF NOT EXISTS user_connector_tools (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  connector_id BIGINT NOT NULL REFERENCES user_connectors(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  input_schema JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, connector_id, tool_name)
);
CREATE INDEX IF NOT EXISTS idx_uct_connector ON user_connector_tools (connector_id);
CREATE INDEX IF NOT EXISTS idx_uct_user_enabled ON user_connector_tools (user_id, enabled);

-- 3. user_connector_toggles: per-connector chat enable/disable
CREATE TABLE IF NOT EXISTS user_connector_toggles (
  user_id BIGINT NOT NULL,
  connector_id BIGINT NOT NULL REFERENCES user_connectors(id) ON DELETE CASCADE,
  chat_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, connector_id)
);

-- 4. tool_call_logs: MCP tool call audit trail
CREATE TABLE IF NOT EXISTS tool_call_logs (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  message_id INTEGER,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_provider TEXT,
  args_json JSONB,
  result_json JSONB,
  status TEXT DEFAULT 'success',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tool_logs_thread ON tool_call_logs (thread_id, created_at DESC);
