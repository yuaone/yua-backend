import { pgPool } from "../db/postgres";

export type SupportAutoReplyChannel = "app" | "web" | "email";
export type SupportAutoReplyJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "retry_wait"
  | "failed"
  | "dead";

export type SupportAutoReplyJob = {
  id: number;
  ticket_id: number;
  channel: SupportAutoReplyChannel;
  recipient_email: string | null;
  status: SupportAutoReplyJobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string | null;
};

export async function enqueueSupportAutoReplyJob(params: {
  ticketId: number;
  channel: SupportAutoReplyChannel;
  recipientEmail: string | null;
}) {
  const { rows } = await pgPool.query<SupportAutoReplyJob>(
    `
    INSERT INTO support_auto_reply_jobs (ticket_id, channel, recipient_email, status, run_after, updated_at)
    VALUES ($1, $2, $3, 'queued', NOW(), NOW())
    ON CONFLICT (ticket_id) WHERE status IN ('queued', 'processing', 'retry_wait')
    DO UPDATE SET
      recipient_email = EXCLUDED.recipient_email,
      channel = EXCLUDED.channel,
      status = CASE
        WHEN support_auto_reply_jobs.status = 'processing' THEN support_auto_reply_jobs.status
        ELSE 'queued'
      END,
      run_after = NOW(),
      updated_at = NOW()
    RETURNING id, ticket_id, channel, recipient_email, status, attempts, max_attempts, run_after, last_error
    `,
    [params.ticketId, params.channel, params.recipientEmail]
  );
  return rows[0] ?? null;
}

export async function claimNextSupportAutoReplyJob(workerId: string): Promise<SupportAutoReplyJob | null> {
  const { rows } = await pgPool.query<SupportAutoReplyJob>(
    `
    WITH picked AS (
      SELECT id
      FROM support_auto_reply_jobs
      WHERE (
          status IN ('queued', 'retry_wait')
          AND run_after <= NOW()
        )
        OR (
          status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at <= NOW() - INTERVAL '2 minutes'
        )
      ORDER BY run_after ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE support_auto_reply_jobs j
    SET
      status = 'processing',
      attempts = j.attempts + 1,
      locked_at = NOW(),
      locked_by = $1,
      started_at = COALESCE(j.started_at, NOW()),
      updated_at = NOW()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.id, j.ticket_id, j.channel, j.recipient_email, j.status, j.attempts, j.max_attempts, j.run_after, j.last_error
    `,
    [workerId]
  );
  return rows[0] ?? null;
}

export async function completeSupportAutoReplyJob(jobId: number) {
  await pgPool.query(
    `
    UPDATE support_auto_reply_jobs
    SET status = 'completed', completed_at = NOW(), updated_at = NOW()
    WHERE id = $1
    `,
    [jobId]
  );
}

export async function failSupportAutoReplyJob(params: {
  jobId: number;
  attempts: number;
  maxAttempts: number;
  error: string;
  retryDelaySeconds: number;
}) {
  const shouldDead = params.attempts >= params.maxAttempts;
  await pgPool.query(
    `
    UPDATE support_auto_reply_jobs
    SET
      status = $2::varchar,
      last_error = LEFT($3, 4000),
      run_after = CASE
        WHEN $2::varchar = 'retry_wait' THEN NOW() + make_interval(secs => $4::int)
        ELSE run_after
      END,
      updated_at = NOW()
    WHERE id = $1
    `,
    [params.jobId, shouldDead ? "dead" : "retry_wait", params.error, params.retryDelaySeconds]
  );
}

export async function saveSupportAutoReplyMessage(params: {
  ticketId: number;
  content: string;
}) {
  await pgPool.query(
    `
    INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, content, is_ai_draft, created_at)
    VALUES ($1, 'system', 0, $2, false, NOW())
    `,
    [params.ticketId, params.content.trim()]
  );

  await pgPool.query(
    `
    UPDATE support_tickets
    SET status = 'waiting_user', updated_at = NOW()
    WHERE id = $1
    `,
    [params.ticketId]
  );
}

export async function recordSupportEmailDelivery(params: {
  ticketId: number;
  jobId: number | null;
  recipientEmail: string;
  status: "sent" | "failed";
  providerMessageId?: string | null;
  errorMessage?: string | null;
}) {
  await pgPool.query(
    `
    INSERT INTO support_email_deliveries (
      ticket_id, job_id, recipient_email, provider, provider_message_id, send_status, error_message, sent_at
    )
    VALUES ($1, $2, $3, 'sendgrid_smtp', $4, $5, $6, CASE WHEN $5 = 'sent' THEN NOW() ELSE NULL END)
    `,
    [
      params.ticketId,
      params.jobId,
      params.recipientEmail,
      params.providerMessageId ?? null,
      params.status,
      params.errorMessage ?? null,
    ]
  );
}

export async function getSupportTicketReplyContext(ticketId: number): Promise<{
  ticketId: number;
  subject: string;
  reporterEmail: string | null;
} | null> {
  const { rows } = await pgPool.query<{
    id: number;
    subject: string;
    reporter_email: string | null;
  }>(
    `
    SELECT id, subject, reporter_email
    FROM support_tickets
    WHERE id = $1
    `,
    [ticketId]
  );

  if (!rows[0]) return null;
  return {
    ticketId: rows[0].id,
    subject: rows[0].subject,
    reporterEmail: rows[0].reporter_email,
  };
}
