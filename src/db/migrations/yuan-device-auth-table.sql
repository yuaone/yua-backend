BEGIN;

-- Table: device_auth_codes — OAuth Device Flow for YUAN CLI
CREATE TABLE IF NOT EXISTS device_auth_codes (
  id SERIAL PRIMARY KEY,
  device_code VARCHAR(64) NOT NULL UNIQUE,   -- Server-side identifier
  user_code VARCHAR(10) NOT NULL UNIQUE,     -- User-facing code (e.g., "YUAN-A7X3")
  client_id VARCHAR(50) NOT NULL DEFAULT 'yuan-cli',
  user_id INTEGER,                           -- Set when user confirms
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | confirmed | expired | used
  scopes TEXT DEFAULT 'agent:run',
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_auth_device_code ON device_auth_codes (device_code);
CREATE INDEX IF NOT EXISTS idx_device_auth_user_code ON device_auth_codes (user_code);
CREATE INDEX IF NOT EXISTS idx_device_auth_status ON device_auth_codes (status, expires_at);

COMMIT;
