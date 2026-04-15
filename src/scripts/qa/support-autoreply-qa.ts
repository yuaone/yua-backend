import "dotenv/config";

import { pgPool } from "../../db/postgres";
import { enqueueSupportAutoReplyJob } from "../../support-ai/support-auto-reply-queue";

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pgPool.query<{ exists: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists
    `,
    [name]
  );
  return Boolean(rows[0]?.exists);
}

async function run() {
  console.log("[QA][support-autoreply] start");

  const jobsTable = await tableExists("support_auto_reply_jobs");
  const deliveriesTable = await tableExists("support_email_deliveries");
  if (!jobsTable || !deliveriesTable) {
    throw new Error("required_support_autoreply_tables_missing");
  }

  const base = await pgPool.query<{ workspace_id: number; user_id: number }>(
    `
    SELECT workspace_id, user_id
    FROM support_tickets
    ORDER BY created_at DESC
    LIMIT 1
    `
  );
  if (!base.rows[0]) {
    throw new Error("no_base_support_ticket_found_for_qa_seed");
  }

  const workspaceId = Number(base.rows[0].workspace_id);
  const userId = Number(base.rows[0].user_id);

  const ticketInsert = await pgPool.query<{ id: number }>(
    `
    INSERT INTO support_tickets (
      workspace_id, user_id, subject, category, priority, status,
      source_platform, reporter_email, client_app_version, client_os
    )
    VALUES ($1, $2, $3, 'general', 'medium', 'open', 'web', 'qa-support@yua.ai', 'qa', 'web')
    RETURNING id
    `,
    [workspaceId, userId, "[QA] support auto reply",]
  );
  const ticketId = Number(ticketInsert.rows[0].id);

  await pgPool.query(
    `
    INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, content)
    VALUES ($1, 'user', $2, $3)
    `,
    [ticketId, userId, "[QA] auto reply smoke message"]
  );

  const queued = await enqueueSupportAutoReplyJob({
    ticketId,
    channel: "web",
    recipientEmail: "qa-support@yua.ai",
  });

  const check = await pgPool.query<{ cnt: string }>(
    `
    SELECT COUNT(*)::text AS cnt
    FROM support_auto_reply_jobs
    WHERE ticket_id = $1 AND status IN ('queued', 'processing', 'retry_wait')
    `,
    [ticketId]
  );

  await pgPool.query("DELETE FROM ticket_messages WHERE ticket_id = $1", [ticketId]);
  await pgPool.query("DELETE FROM support_tickets WHERE id = $1", [ticketId]);

  const queueCount = Number(check.rows[0]?.cnt ?? "0");
  console.log(
    JSON.stringify(
      {
        ok: true,
        tables: {
          support_auto_reply_jobs: jobsTable,
          support_email_deliveries: deliveriesTable,
        },
        queue_inserted: Boolean(queued?.id),
        queue_count_before_cleanup: queueCount,
      },
      null,
      2
    )
  );
}

run()
  .catch((err) => {
    console.error("[QA][support-autoreply] failed:", err?.message ?? err);
    process.exit(1);
  })
  .finally(async () => {
    await pgPool.end().catch(() => undefined);
  });
