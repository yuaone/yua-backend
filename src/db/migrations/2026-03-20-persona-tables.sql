-- 🔒 Persona 테이블 생성 (2026-03-20)
-- persona-aggregator.ts, persona-aggregate-reader.ts, workspace-persona-policy.ts에서 사용

-- 1. 페르소나 통계 (유저별 행동 패턴 추적)
CREATE TABLE IF NOT EXISTS persona_aggregate (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  persona TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  samples INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id, persona)
);

CREATE INDEX IF NOT EXISTS idx_persona_aggregate_ws_user
  ON persona_aggregate (workspace_id, user_id);

-- 2. 워크스페이스 페르소나 정책 (관리자 설정)
CREATE TABLE IF NOT EXISTS workspace_persona_policy (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  persona TEXT NOT NULL,
  allow_personal_tone BOOLEAN NOT NULL DEFAULT false,
  allow_name_call BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, persona)
);

CREATE INDEX IF NOT EXISTS idx_workspace_persona_policy_ws
  ON workspace_persona_policy (workspace_id);
