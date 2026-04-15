-- device_tokens: CLI/Desktop/SDK 영구 인증 토큰
CREATE TABLE IF NOT EXISTS device_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  token_hash    VARCHAR(64) NOT NULL UNIQUE,
  token_prefix  VARCHAR(10) NOT NULL,
  device_name   VARCHAR(100),
  client_type   VARCHAR(20) NOT NULL,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_active
  ON device_tokens(token_hash) WHERE revoked_at IS NULL;
