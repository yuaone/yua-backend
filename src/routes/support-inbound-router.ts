import { Router, Request, Response } from "express";
import type { RowDataPacket } from "mysql2/promise";
import { db as mysqlPool } from "../db/mysql";
import { pgPool } from "../db/postgres";
import { enqueueSupportAutoReplyJob } from "../support-ai/support-auto-reply-queue";

const router = Router();

function normalizeEmail(input: unknown): string | null {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw || raw.length > 320) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

function readInboundSecret(req: Request): string {
  const headerSecret = String(req.headers["x-support-inbound-secret"] ?? "").trim();
  const bodySecret = String((req.body as any)?.secret ?? "").trim();
  return headerSecret || bodySecret;
}

async function resolveUserAndWorkspaceByEmail(email: string): Promise<{ userId: number; workspaceId: number } | null> {
  const [uRows] = await mysqlPool.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1",
    [email]
  );
  const userId = Number(uRows?.[0]?.id ?? 0);
  if (!userId) return null;

  const { rows } = await pgPool.query<{ workspace_id: string }>(
    `
    SELECT workspace_id
    FROM workspace_users
    WHERE user_id = $1
    ORDER BY workspace_id ASC
    LIMIT 1
    `,
    [userId]
  );
  const workspaceId = Number(rows?.[0]?.workspace_id ?? 0);
  if (!workspaceId) return null;

  return { userId, workspaceId };
}

router.post("/email", async (req: Request, res: Response) => {
  try {
    const secret = readInboundSecret(req);
    const expectedSecret = String(process.env.SUPPORT_INBOUND_SECRET ?? "").trim();
    if (!expectedSecret || secret !== expectedSecret) {
      return res.status(401).json({ ok: false, error: "unauthorized_inbound" });
    }

    const from = normalizeEmail((req.body as any)?.from ?? (req.body as any)?.sender ?? (req.body as any)?.email);
    const subject = String((req.body as any)?.subject ?? "").trim().slice(0, 500);
    const contentRaw = String((req.body as any)?.text ?? (req.body as any)?.content ?? "").trim();
    const content = contentRaw.slice(0, 10000);
    if (!from || !subject || !content) {
      return res.status(400).json({ ok: false, error: "invalid_inbound_payload" });
    }

    const resolved = await resolveUserAndWorkspaceByEmail(from);
    if (!resolved) {
      return res.status(404).json({ ok: false, error: "user_or_workspace_not_found" });
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");

      const ticketResult = await client.query<{
        id: number;
        source_platform: string;
        reporter_email: string | null;
      }>(
        `
        INSERT INTO support_tickets (
          workspace_id, user_id, subject, category, priority, status,
          source_platform, reporter_email, client_app_version, client_os
        )
        VALUES ($1, $2, $3, 'general', 'medium', 'open', 'unknown', $4, NULL, 'email')
        RETURNING id, source_platform, reporter_email
        `,
        [resolved.workspaceId, resolved.userId, subject, from]
      );

      const ticket = ticketResult.rows[0];

      await client.query(
        `
        INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, content)
        VALUES ($1, 'user', $2, $3)
        `,
        [ticket.id, resolved.userId, content]
      );

      await client.query("COMMIT");

      await enqueueSupportAutoReplyJob({
        ticketId: ticket.id,
        channel: "email",
        recipientEmail: from,
      });

      return res.json({ ok: true, data: { ticket_id: ticket.id } });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error("[support-inbound] POST /email error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "failed_to_process_inbound" });
  }
});

export default router;
