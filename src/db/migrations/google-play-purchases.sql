CREATE TABLE IF NOT EXISTS google_play_purchases (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL,
  user_id BIGINT NOT NULL,
  product_type VARCHAR(32) NOT NULL,
  product_id VARCHAR(255) NOT NULL,
  purchase_token VARCHAR(512) NOT NULL UNIQUE,
  order_id VARCHAR(255),
  entitlement_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  purchase_state VARCHAR(64),
  expiry_time TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_google_play_purchases_workspace
  ON google_play_purchases (workspace_id, product_type, entitlement_status);

CREATE INDEX IF NOT EXISTS idx_google_play_purchases_revoked
  ON google_play_purchases (revoked_at);
