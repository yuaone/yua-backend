-- ============================================
-- YUA MySQL → PostgreSQL Migration
-- 2026-04-10
-- ============================================

-- 1. USERS (MySQL users → PostgreSQL)
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  firebase_uid  VARCHAR(128) UNIQUE,          -- 마이그레이션 호환용, 추후 제거
  email         VARCHAR(255) NOT NULL,
  name          VARCHAR(255),
  plan_id       VARCHAR(64) DEFAULT 'free',
  credits       INT DEFAULT 0,
  tier          VARCHAR(20) DEFAULT 'free',
  role          VARCHAR(20) DEFAULT 'user',
  daily_usage   INT DEFAULT 0,
  monthly_usage INT DEFAULT 0,
  usage_reset_at TIMESTAMPTZ,
  phone         VARCHAR(30),
  birth_date    DATE,
  auth_provider VARCHAR(20),                  -- 'google', 'apple', 'email'
  avatar_url    TEXT,
  password_hash VARCHAR(255),                 -- 자체 인증용 (bcrypt)
  oauth_uid     VARCHAR(255),                 -- Google/Apple sub ID
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_oauth_uid ON users(oauth_uid) WHERE oauth_uid IS NOT NULL;

-- 2. AUTH SESSIONS (신규 — httpOnly cookie 세션)
CREATE TABLE IF NOT EXISTS auth_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(64) UNIQUE NOT NULL,    -- SHA-256 of session token
  device_info JSONB,                          -- user agent, IP, etc.
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

-- 3. SUBSCRIPTIONS
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      SERIAL PRIMARY KEY,
  user_id                 VARCHAR(50) NOT NULL,
  workspace_id            VARCHAR(50),
  plan                    VARCHAR(100) NOT NULL,
  status                  VARCHAR(20) DEFAULT 'pending',  -- pending/trial/active/canceled/expired
  order_id                VARCHAR(255) UNIQUE,
  payment_key             VARCHAR(255),
  provider                VARCHAR(50),
  next_billing_at         TIMESTAMPTZ,
  grace_until             TIMESTAMPTZ,
  renewal_attempts        INT DEFAULT 0,
  scheduled_downgrade_plan VARCHAR(100),
  amount                  INT DEFAULT 0,
  currency                VARCHAR(10) DEFAULT 'KRW',
  paid_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_workspace ON subscriptions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- 4. PLANS
CREATE TABLE IF NOT EXISTS plans (
  id              VARCHAR(64) PRIMARY KEY,
  type            VARCHAR(20) NOT NULL,         -- free/pro/business/enterprise
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  base_price      DECIMAL(10,2) DEFAULT 0,
  multiplier      DOUBLE PRECISION DEFAULT 1,
  daily_limit     INT DEFAULT 1000,
  monthly_limit   INT DEFAULT 5000,
  quantum_enabled BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 5. CHAT STREAM EVENTS (635K rows — 가장 큰 테이블)
CREATE TABLE IF NOT EXISTS chat_stream_events_v2 (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   BIGINT NOT NULL,
  trace_id    VARCHAR(64) NOT NULL,
  stage       VARCHAR(64) NOT NULL,
  token       TEXT,
  done        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stream_events_thread ON chat_stream_events_v2(thread_id);
CREATE INDEX IF NOT EXISTS idx_stream_events_trace ON chat_stream_events_v2(trace_id);

-- 6. CHAT LOGS
CREATE TABLE IF NOT EXISTS chat_logs (
  id            BIGSERIAL PRIMARY KEY,
  timestamp     TIMESTAMPTZ,
  instance_id   VARCHAR(64),
  route         VARCHAR(255),
  method        VARCHAR(10),
  ip            VARCHAR(64),
  api_key_hash  VARCHAR(255),
  plan          VARCHAR(50),
  user_type     VARCHAR(50),
  request       JSONB,
  response      JSONB,
  latency_ms    INT,
  model         VARCHAR(100),
  tokens        INT,
  error         TEXT,
  superadmin    BOOLEAN,
  lite_pipeline JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 7. PROMPT LOGS
CREATE TABLE IF NOT EXISTS prompt_logs (
  id          BIGSERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ,
  route       VARCHAR(255),
  prompt      TEXT,
  model       VARCHAR(100),
  tokens      INT,
  request     JSONB,
  response    TEXT,
  latency     INT,
  ip          VARCHAR(45),
  api_key     VARCHAR(255),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 8. MEMORY STORE
CREATE TABLE IF NOT EXISTS memory_store (
  id          BIGSERIAL PRIMARY KEY,
  type        VARCHAR(20) NOT NULL,           -- short/long/project
  role        VARCHAR(50),
  content     TEXT,
  key_name    VARCHAR(255),
  value       TEXT,
  project_id  VARCHAR(255),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_store_type ON memory_store(type);
CREATE INDEX IF NOT EXISTS idx_memory_store_key ON memory_store(key_name);
CREATE INDEX IF NOT EXISTS idx_memory_store_project ON memory_store(project_id);

-- 9. YUA USAGE DAILY
CREATE TABLE IF NOT EXISTS yua_usage_daily (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL,
  date           DATE NOT NULL,
  total_tokens   INT DEFAULT 0,
  calls          INT DEFAULT 0,
  image_calls    INT DEFAULT 0,
  cost_unit      BIGINT DEFAULT 0,
  message_count  INT DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_user_date ON yua_usage_daily(user_id, date);

-- 10. API KEYS V2
CREATE TABLE IF NOT EXISTS api_keys_v2 (
  id            SERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  workspace_id  VARCHAR(50),
  key_hash      VARCHAR(255) UNIQUE NOT NULL,
  key_prefix    VARCHAR(20),
  name          VARCHAR(255),
  scopes        JSONB,
  rate_limit    INT DEFAULT 60,
  expires_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
