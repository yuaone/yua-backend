BEGIN;

ALTER TABLE workspace_invitations
  DROP CONSTRAINT IF EXISTS workspace_invitations_status_check;

ALTER TABLE workspace_invitations
  ADD CONSTRAINT workspace_invitations_status_check
  CHECK (
    status = ANY (
      ARRAY[
        'pending'::text,
        'pending_approval'::text,
        'approved'::text,
        'accepted'::text,
        'revoked'::text,
        'expired'::text
      ]
    )
  );

DROP INDEX IF EXISTS uq_workspace_invite_pending;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invite_pending
  ON workspace_invitations (workspace_id, email)
  WHERE status IN ('pending', 'pending_approval', 'approved');

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invitation_token
  ON workspace_invitations (token);

CREATE TABLE IF NOT EXISTS workspace_invitation_email_delivery_logs (
  id BIGSERIAL PRIMARY KEY,
  invitation_id UUID NOT NULL REFERENCES workspace_invitations(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'smtp',
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  message_id TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_invite_email_log_invitation
  ON workspace_invitation_email_delivery_logs (invitation_id, created_at DESC);

COMMIT;

