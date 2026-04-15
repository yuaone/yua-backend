// src/routes/admin-router.ts
// Admin API Router — 14 endpoints for yua-console

import { Router, Request, Response } from "express";
import { createHash } from "crypto";
import { pgPool } from "../db/postgres";
import { mysqlPool } from "../db/mysql";
import { validateAdminSession } from "../middleware/admin-session";
import { requireRole } from "../middleware/admin-rbac";
import { logAdminAction } from "../middleware/admin-iam";
import { log, logError } from "../utils/logger";
import { PLAN_CONFIGS } from "yua-shared/plan/plan-pricing";
import { SupportAIEngine } from "../support-ai/support-ai-engine";
import { SupportKnowledgeRepo } from "../support-ai/support-knowledge-repo";

export const adminRouter = Router();

// All admin routes require valid admin session
adminRouter.use(validateAdminSession);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parsePagination(req: Request) {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

let supportSettingsSchemaReady = false;
async function ensureSupportSettingsSchema(): Promise<void> {
  if (supportSettingsSchemaReady) return;

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS support_escalation_rules (
      id BIGSERIAL PRIMARY KEY,
      condition_type TEXT NOT NULL,
      condition_value TEXT NOT NULL,
      action TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by BIGINT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.query(
    `CREATE INDEX IF NOT EXISTS idx_support_escalation_rules_active
     ON support_escalation_rules (is_active, created_at DESC)`
  );

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS support_auto_send_config (
      id SMALLINT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      confidence_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.85,
      updated_by BIGINT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    INSERT INTO support_auto_send_config (id, enabled, confidence_threshold)
    VALUES (1, FALSE, 0.85)
    ON CONFLICT (id) DO NOTHING
  `);

  supportSettingsSchemaReady = true;
}

// ---------------------------------------------------------------------------
// 1. GET /admin/users — list all users (MySQL)
// ---------------------------------------------------------------------------
adminRouter.get("/users", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const search = (req.query.search as string) || "";
    const roleFilter = (req.query.role as string) || "";
    const planFilter = (req.query.plan as string) || "";
    const statusFilter = (req.query.status as string) || "";

    const conditions: string[] = [];
    const params: any[] = [];
    if (search) {
      conditions.push("(email LIKE ? OR name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    if (roleFilter) {
      conditions.push("role = ?");
      params.push(roleFilter);
    }
    if (planFilter) {
      conditions.push("plan_id = ?");
      params.push(planFilter);
    }
    if (statusFilter === "banned") {
      conditions.push("COALESCE(is_banned, 0) = 1");
    } else if (statusFilter === "inactive") {
      conditions.push("(COALESCE(is_banned, 0) = 0 AND (last_login_at IS NULL OR last_login_at < NOW() - INTERVAL 30 DAY))");
    } else if (statusFilter === "active") {
      conditions.push("(COALESCE(is_banned, 0) = 0 AND last_login_at IS NOT NULL AND last_login_at >= NOW() - INTERVAL 30 DAY)");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[countRow]]: any = await mysqlPool.query(
      `SELECT COUNT(*) AS total FROM users ${where}`,
      params
    );
    const total = countRow?.total ?? 0;

    const [rows]: any = await mysqlPool.query(
      `SELECT id, firebase_uid, email, name, role, auth_provider, plan_id,
              credits, daily_usage, monthly_usage,
              created_at, updated_at, last_login_at, is_banned,
              CASE
                WHEN COALESCE(is_banned, 0) = 1 THEN 'banned'
                WHEN last_login_at IS NULL OR last_login_at < NOW() - INTERVAL 30 DAY THEN 'inactive'
                ELSE 'active'
              END AS status
       FROM users ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ ok: true, data: { users: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /users error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch users" });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /admin/users/:id — single user detail (MySQL)
// ---------------------------------------------------------------------------
adminRouter.get("/users/:id", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) return res.status(400).json({ ok: false, error: "Invalid user ID" });

    const [rows]: any = await mysqlPool.query(
      `SELECT id, firebase_uid, email, name, role, auth_provider, plan_id, created_at, last_login_at
       FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: "User not found" });

    // workspace memberships (PostgreSQL)
    const { rows: workspaces } = await pgPool.query(
      `SELECT w.id, w.name, wu.role, wu.joined_at
       FROM workspace_users wu
       JOIN workspaces w ON w.id = wu.workspace_id
       WHERE wu.user_id = $1
       ORDER BY wu.joined_at DESC`,
      [userId]
    );

    // thread count (PostgreSQL)
    const { rows: threadCount } = await pgPool.query(
      `SELECT COUNT(*)::text AS count FROM chat_threads WHERE user_id = $1`,
      [userId]
    );

    // P0-fix: recentThreads 반환 (최근 10개)
    const { rows: recentThreads } = await pgPool.query(
      `SELECT id, title, model, created_at
       FROM chat_threads
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    res.json({
      ok: true,
      data: {
        user: rows[0],
        workspaces,
        threadCount: parseInt(threadCount[0]?.count ?? "0"),
        recentThreads,
      },
    });
  } catch (err) {
    logError("[admin] GET /users/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch user" });
  }
});

// ---------------------------------------------------------------------------
// 3. PATCH /admin/users/:id — update user (MySQL)
// ---------------------------------------------------------------------------
adminRouter.patch("/users/:id", requireRole("superadmin"), async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) return res.status(400).json({ ok: false, error: "Invalid user ID" });

    const { role, plan_id, is_banned } = req.body;

    // Get before state
    const [beforeRows]: any = await mysqlPool.query(
      `SELECT role, plan_id FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    if (!beforeRows.length) return res.status(404).json({ ok: false, error: "User not found" });

    const updates: string[] = [];
    const params: any[] = [];

    const VALID_ROLES = ["user", "admin"];
    const VALID_PLANS = Object.keys(PLAN_CONFIGS);

    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) return res.status(400).json({ ok: false, error: "Invalid role" });
      updates.push("role = ?");
      params.push(role);
    }
    if (plan_id !== undefined) {
      if (!VALID_PLANS.includes(plan_id)) return res.status(400).json({ ok: false, error: "Invalid plan_id" });
      updates.push("plan_id = ?");
      params.push(plan_id);
    }
    if (is_banned !== undefined) {
      updates.push("is_banned = ?");
      params.push(is_banned ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: "No fields to update" });
    }

    params.push(userId);
    await mysqlPool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    await logAdminAction(
      req.admin!.id,
      "update_user",
      "user",
      String(userId),
      JSON.stringify(beforeRows[0]),
      JSON.stringify({ role, plan_id, is_banned }),
      clientIp(req)
    );

    res.json({ ok: true, data: { userId, updated: { role, plan_id, is_banned } } });
  } catch (err) {
    logError("[admin] PATCH /users/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to update user" });
  }
});

// ---------------------------------------------------------------------------
// 4. GET /admin/stats — system stats
// ---------------------------------------------------------------------------
adminRouter.get("/stats", requireRole("viewer"), async (_req: Request, res: Response) => {
  try {
    // Total users (MySQL)
    const [[userCount]]: any = await mysqlPool.query("SELECT COUNT(*) AS total FROM users");

    // Active today (MySQL) — last_login_at within 24h
    const [[activeToday]]: any = await mysqlPool.query(
      "SELECT COUNT(*) AS total FROM users WHERE last_login_at >= NOW() - INTERVAL 1 DAY"
    );

    // Total threads (PostgreSQL)
    const { rows: threadCount } = await pgPool.query(
      "SELECT COUNT(*)::text AS total FROM chat_threads"
    );

    // Total messages (PostgreSQL)
    const { rows: msgCount } = await pgPool.query(
      "SELECT COUNT(*)::text AS total FROM chat_messages"
    );

    res.json({
      ok: true,
      data: {
        totalUsers: userCount?.total ?? 0,
        activeToday: activeToday?.total ?? 0,
        totalThreads: parseInt(threadCount[0]?.total ?? "0"),
        totalMessages: parseInt(msgCount[0]?.total ?? "0"),
      },
    });
  } catch (err) {
    logError("[admin] GET /stats error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch stats" });
  }
});

// ---------------------------------------------------------------------------
// 5. GET /admin/stats/revenue — revenue stats (PostgreSQL)
// ---------------------------------------------------------------------------
adminRouter.get("/stats/revenue", requireRole("billing_manager"), async (_req: Request, res: Response) => {
  try {
    // Subscriptions by plan
    const { rows: planStats } = await pgPool.query(
      `SELECT plan_id, status, COUNT(*)::text AS count
       FROM subscriptions
       GROUP BY plan_id, status
       ORDER BY plan_id`
    );

    // Credit usage totals
    const { rows: creditStats } = await pgPool.query(
      `SELECT
         COALESCE(SUM(total_purchased), 0) AS total_purchased,
         COALESCE(SUM(total_used), 0) AS total_used,
         COALESCE(SUM(balance), 0) AS total_balance
       FROM api_credits`
    );

    // Recent credit transactions (last 30 days)
    const { rows: recentTx } = await pgPool.query(
      `SELECT type, COUNT(*)::text AS count, COALESCE(SUM(ABS(amount)), 0) AS total_amount
       FROM credit_transactions
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY type`
    );

    res.json({
      ok: true,
      data: {
        subscriptions: planStats,
        credits: creditStats[0] ?? { total_purchased: 0, total_used: 0, total_balance: 0 },
        recentTransactions: recentTx,
      },
    });
  } catch (err) {
    logError("[admin] GET /stats/revenue error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch revenue stats" });
  }
});

// ---------------------------------------------------------------------------
// 6. GET /admin/workspaces — list workspaces (PostgreSQL)
// ---------------------------------------------------------------------------
adminRouter.get("/workspaces", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const search = (req.query.search as string) || "";

    // P0-fix: search 파라미터 지원 (이름/slug 검색)
    const searchWhere = search
      ? "WHERE w.name ILIKE $1 OR w.slug ILIKE $1"
      : "";
    const searchParams = search ? [`%${search}%`] : [];
    const pIdx = searchParams.length + 1;

    const { rows: countRows } = await pgPool.query(
      `SELECT COUNT(*)::text AS total FROM workspaces w ${searchWhere}`,
      searchParams
    );
    const total = parseInt(countRows[0]?.total ?? "0");

    const { rows } = await pgPool.query(
      `SELECT id, name, slug, owner_id, plan_id, created_at,
              (SELECT COUNT(*) FROM workspace_users wu WHERE wu.workspace_id = w.id)::text AS member_count
       FROM workspaces w
       ${searchWhere}
       ORDER BY w.id DESC
       LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
      [...searchParams, limit, offset]
    );

    res.json({ ok: true, data: { workspaces: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /workspaces error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch workspaces" });
  }
});

// ---------------------------------------------------------------------------
// 7. GET /admin/workspaces/:id — workspace detail (PostgreSQL)
// ---------------------------------------------------------------------------
adminRouter.get("/workspaces/:id", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const wsId = parseInt(req.params.id);
    if (isNaN(wsId)) return res.status(400).json({ ok: false, error: "Invalid workspace ID" });

    const { rows: wsRows } = await pgPool.query(
      `SELECT * FROM workspaces WHERE id = $1 LIMIT 1`,
      [wsId]
    );
    if (!wsRows.length) return res.status(404).json({ ok: false, error: "Workspace not found" });

    const { rows: members } = await pgPool.query(
      `SELECT wu.user_id, wu.role, wu.joined_at
       FROM workspace_users wu
       WHERE wu.workspace_id = $1
       ORDER BY wu.joined_at`,
      [wsId]
    );

    // Enrich with user info from MySQL
    const userIds = members.map((m: any) => m.user_id);
    let userMap: Record<number, any> = {};
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const [userRows]: any = await mysqlPool.query(
        `SELECT id, email, name FROM users WHERE id IN (${placeholders})`,
        userIds
      );
      for (const u of userRows) {
        userMap[u.id] = u;
      }
    }

    const enrichedMembers = members.map((m: any) => ({
      ...m,
      email: userMap[m.user_id]?.email ?? null,
      name: userMap[m.user_id]?.name ?? null,
    }));

    res.json({
      ok: true,
      data: { workspace: wsRows[0], members: enrichedMembers },
    });
  } catch (err) {
    logError("[admin] GET /workspaces/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch workspace" });
  }
});

// ---------------------------------------------------------------------------
// 8. GET /admin/threads — recent threads (PostgreSQL)
// ---------------------------------------------------------------------------
adminRouter.get("/threads", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const userId = req.query.user_id ? parseInt(req.query.user_id as string) : null;

    let where = "";
    const params: any[] = [];
    let paramIdx = 1;

    if (userId) {
      where = `WHERE user_id = $${paramIdx++}`;
      params.push(userId);
    }

    const { rows: countRows } = await pgPool.query(
      `SELECT COUNT(*)::text AS total FROM chat_threads ${where}`,
      params
    );
    const total = parseInt(countRows[0]?.total ?? "0");

    const { rows } = await pgPool.query(
      `SELECT id, user_id, workspace_id, title, model, created_at, updated_at
       FROM chat_threads ${where}
       ORDER BY updated_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    res.json({ ok: true, data: { threads: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /threads error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch threads" });
  }
});

// ---------------------------------------------------------------------------
// 9. GET /admin/threads/:id/messages — thread messages (PostgreSQL)
// ---------------------------------------------------------------------------
adminRouter.get("/threads/:id/messages", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const threadId = parseInt(req.params.id);
    if (isNaN(threadId)) return res.status(400).json({ ok: false, error: "Invalid thread ID" });

    const { page, limit, offset } = parsePagination(req);

    const { rows: countRows } = await pgPool.query(
      `SELECT COUNT(*)::text AS total FROM chat_messages WHERE thread_id = $1`,
      [threadId]
    );
    const total = parseInt(countRows[0]?.total ?? "0");

    const { rows } = await pgPool.query(
      `SELECT id, thread_id, role, content, model, token_count, created_at
       FROM chat_messages
       WHERE thread_id = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [threadId, limit, offset]
    );

    res.json({ ok: true, data: { messages: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /threads/:id/messages error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch messages" });
  }
});

// ---------------------------------------------------------------------------
// 10. GET /admin/tickets — support tickets (PostgreSQL)
// ---------------------------------------------------------------------------
adminRouter.get("/tickets", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const status = req.query.status as string | undefined;
    const priority = req.query.priority as string | undefined;
    const sourcePlatform = (req.query.source_platform as string | undefined)?.trim();

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`t.status = $${paramIdx++}`);
      params.push(status);
    }
    if (priority) {
      conditions.push(`t.priority = $${paramIdx++}`);
      params.push(priority);
    }
    if (sourcePlatform) {
      conditions.push(`t.source_platform = $${paramIdx++}`);
      params.push(sourcePlatform);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: countRows } = await pgPool.query(
      `SELECT COUNT(*)::text AS total FROM support_tickets t ${where}`,
      params
    );
    const total = parseInt(countRows[0]?.total ?? "0");

    const { rows } = await pgPool.query(
      `SELECT t.id, t.workspace_id, t.user_id, t.subject, t.category, t.priority, t.status,
              t.source_platform, t.reporter_email, t.client_app_version, t.client_os,
              t.assigned_admin_id, t.created_at, t.updated_at, t.resolved_at,
              j.status AS auto_reply_status,
              j.attempts AS auto_reply_attempts,
              j.max_attempts AS auto_reply_max_attempts,
              j.last_error AS auto_reply_last_error,
              j.updated_at AS auto_reply_updated_at,
              d.send_status AS latest_email_status,
              d.sent_at AS latest_email_sent_at
       FROM support_tickets t
       LEFT JOIN LATERAL (
         SELECT status, attempts, max_attempts, last_error, updated_at
         FROM support_auto_reply_jobs
         WHERE ticket_id = t.id
         ORDER BY created_at DESC
         LIMIT 1
       ) j ON TRUE
       LEFT JOIN LATERAL (
         SELECT send_status, sent_at
         FROM support_email_deliveries
         WHERE ticket_id = t.id
         ORDER BY created_at DESC
         LIMIT 1
       ) d ON TRUE
       ${where}
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         t.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );
    const userIds = Array.from(new Set(rows.map((row: any) => Number(row.user_id)).filter(Number.isFinite)));
    let userMap: Record<number, { email: string | null; name: string | null }> = {};
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const [userRows]: any = await mysqlPool.query(
        `SELECT id, email, name FROM users WHERE id IN (${placeholders})`,
        userIds
      );
      userMap = Object.fromEntries(
        userRows.map((u: any) => [Number(u.id), { email: u.email ?? null, name: u.name ?? null }])
      );
    }

    const enrichedTickets = rows.map((row: any) => ({
      ...row,
      user_email: userMap[Number(row.user_id)]?.email ?? null,
      user_name: userMap[Number(row.user_id)]?.name ?? null,
    }));

    res.json({ ok: true, data: { tickets: enrichedTickets, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /tickets error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch tickets" });
  }
});

// ---------------------------------------------------------------------------
// 11. POST /admin/tickets/:id/reply — admin reply to ticket
// ---------------------------------------------------------------------------
adminRouter.post("/tickets/:id/reply", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return res.status(400).json({ ok: false, error: "Invalid ticket ID" });

    const { content } = req.body;
    if (!content || typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ ok: false, error: "Content is required" });
    }
    if (content.length > 50000) {
      return res.status(400).json({ ok: false, error: "Content too long (max 50000)" });
    }

    // Verify ticket exists
    const { rows: ticketRows } = await pgPool.query(
      "SELECT id, status FROM support_tickets WHERE id = $1",
      [ticketId]
    );
    if (!ticketRows.length) return res.status(404).json({ ok: false, error: "Ticket not found" });

    // Insert message
    const { rows: msgRows } = await pgPool.query(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, content, created_at)
       VALUES ($1, 'admin', $2, $3, NOW())
       RETURNING id, created_at`,
      [ticketId, req.admin!.id, content.trim()]
    );

    // Update ticket updated_at and set to in_progress if open
    await pgPool.query(
      `UPDATE support_tickets
       SET updated_at = NOW(),
           status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
       WHERE id = $1`,
      [ticketId]
    );

    await logAdminAction(
      req.admin!.id,
      "ticket_reply",
      "ticket",
      String(ticketId),
      null,
      JSON.stringify({ messageId: msgRows[0].id }),
      clientIp(req)
    );

    res.json({ ok: true, data: { messageId: msgRows[0].id, createdAt: msgRows[0].created_at } });
  } catch (err) {
    logError("[admin] POST /tickets/:id/reply error:", err);
    res.status(500).json({ ok: false, error: "Failed to reply to ticket" });
  }
});

// ---------------------------------------------------------------------------
// 12. PATCH /admin/tickets/:id — update ticket
// ---------------------------------------------------------------------------
adminRouter.patch("/tickets/:id", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return res.status(400).json({ ok: false, error: "Invalid ticket ID" });

    const { status, priority, category, assigned_admin_id } = req.body;

    // Get before state
    const { rows: beforeRows } = await pgPool.query(
      "SELECT status, priority, category, assigned_admin_id FROM support_tickets WHERE id = $1",
      [ticketId]
    );
    if (!beforeRows.length) return res.status(404).json({ ok: false, error: "Ticket not found" });

    const sets: string[] = ["updated_at = NOW()"];
    const params: any[] = [];
    let paramIdx = 1;

    const VALID_STATUSES = ["open", "in_progress", "waiting_user", "resolved", "closed"];
    const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
    const VALID_CATEGORIES = ["bug", "billing", "account", "feature", "general"];

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: "Invalid status" });
      sets.push(`status = $${paramIdx++}`);
      params.push(status);
      if (status === "resolved" || status === "closed") {
        sets.push(`resolved_at = NOW()`);
      }
    }
    if (priority !== undefined) {
      if (!VALID_PRIORITIES.includes(priority)) return res.status(400).json({ ok: false, error: "Invalid priority" });
      sets.push(`priority = $${paramIdx++}`);
      params.push(priority);
    }
    if (category !== undefined) {
      if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ ok: false, error: "Invalid category" });
      sets.push(`category = $${paramIdx++}`);
      params.push(category);
    }
    if (assigned_admin_id !== undefined) {
      sets.push(`assigned_admin_id = $${paramIdx++}`);
      params.push(assigned_admin_id);
    }

    params.push(ticketId);
    await pgPool.query(
      `UPDATE support_tickets SET ${sets.join(", ")} WHERE id = $${paramIdx}`,
      params
    );

    await logAdminAction(
      req.admin!.id,
      "update_ticket",
      "ticket",
      String(ticketId),
      JSON.stringify(beforeRows[0]),
      JSON.stringify({ status, priority, category, assigned_admin_id }),
      clientIp(req)
    );

    res.json({ ok: true, data: { ticketId, updated: { status, priority, category, assigned_admin_id } } });
  } catch (err) {
    logError("[admin] PATCH /tickets/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to update ticket" });
  }
});

// ---------------------------------------------------------------------------
// 13. GET /admin/audit — audit log list (PostgreSQL)
// ---------------------------------------------------------------------------
adminRouter.get("/audit", requireRole("superadmin"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const adminId = req.query.admin_id ? parseInt(req.query.admin_id as string) : null;
    const adminSearch = (req.query.admin as string) || "";
    const action = req.query.action as string | undefined;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (adminId) {
      conditions.push(`a.admin_id = $${paramIdx++}`);
      params.push(adminId);
    } else if (adminSearch) {
      // P0-fix: 프론트가 admin 파라미터로 이름/이메일 텍스트 검색
      conditions.push(`(u.email ILIKE $${paramIdx} OR u.name ILIKE $${paramIdx})`);
      params.push(`%${adminSearch}%`);
      paramIdx++;
    }
    if (action) {
      conditions.push(`a.action = $${paramIdx++}`);
      params.push(action);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countJoin = adminSearch
      ? "JOIN admin_users u ON u.id = a.admin_id"
      : "";
    const { rows: countRows } = await pgPool.query(
      `SELECT COUNT(*)::text AS total FROM admin_audit_logs a ${countJoin} ${where}`,
      params
    );
    const total = parseInt(countRows[0]?.total ?? "0");

    const { rows } = await pgPool.query(
      `SELECT a.id, a.admin_id, u.email AS admin_email, u.name AS admin_name,
              a.action, a.target_type, a.target_id,
              a.before_value, a.after_value, a.ip_address, a.created_at
       FROM admin_audit_logs a
       JOIN admin_users u ON u.id = a.admin_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    res.json({ ok: true, data: { logs: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /audit error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch audit logs" });
  }
});

// ---------------------------------------------------------------------------
// 14. GET /admin/monitor/stream — SSE real-time system metrics
// ---------------------------------------------------------------------------
adminRouter.get("/monitor/stream", requireRole("admin"), async (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("connected", { time: new Date().toISOString() });

  const interval = setInterval(async () => {
    try {
      // System metrics snapshot
      const memUsage = process.memoryUsage();

      // Active sessions count
      const { rows: sessionCount } = await pgPool.query(
        "SELECT COUNT(*)::text AS count FROM admin_sessions WHERE expires_at > NOW()"
      );

      // Recent threads (last hour)
      const { rows: recentThreads } = await pgPool.query(
        "SELECT COUNT(*)::text AS count FROM chat_threads WHERE created_at >= NOW() - INTERVAL '1 hour'"
      );

      // Recent messages (last hour)
      const { rows: recentMsgs } = await pgPool.query(
        "SELECT COUNT(*)::text AS count FROM chat_messages WHERE created_at >= NOW() - INTERVAL '1 hour'"
      );

      // Open tickets
      const { rows: openTickets } = await pgPool.query(
        "SELECT COUNT(*)::text AS count FROM support_tickets WHERE status IN ('open', 'in_progress')"
      );

      sendEvent("metrics", {
        timestamp: new Date().toISOString(),
        memory: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss: Math.round(memUsage.rss / 1024 / 1024),
        },
        activeSessions: parseInt(sessionCount[0]?.count ?? "0"),
        threadsLastHour: parseInt(recentThreads[0]?.count ?? "0"),
        messagesLastHour: parseInt(recentMsgs[0]?.count ?? "0"),
        openTickets: parseInt(openTickets[0]?.count ?? "0"),
      });
    } catch (err) {
      logError("[admin] SSE metrics error:", err);
    }
  }, 10000); // every 10 seconds

  // Keep-alive ping
  const pingInterval = setInterval(() => {
    res.write(": ping\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(interval);
    clearInterval(pingInterval);
    log("[admin] SSE monitor stream closed");
  });
});

// ---------------------------------------------------------------------------
// 15. POST /admin/tickets/:id/ai-draft — Generate AI draft reply
// ---------------------------------------------------------------------------
adminRouter.post("/tickets/:id/ai-draft", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return res.status(400).json({ ok: false, error: "Invalid ticket ID" });

    const result = await SupportAIEngine.generateDraft(ticketId);
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: "AI draft generation failed" });
    }

    await logAdminAction(
      req.admin!.id, "ai_draft", "ticket", String(ticketId),
      null, JSON.stringify({ draft: result.draft?.slice(0, 100) }), clientIp(req)
    );

    res.json({ ok: true, data: { draft: result.draft, sources: result.sources } });
  } catch (err) {
    logError("[admin] POST /tickets/:id/ai-draft error:", err);
    res.status(500).json({ ok: false, error: "Failed to generate AI draft" });
  }
});

// ---------------------------------------------------------------------------
// 16. POST /admin/tickets/:id/approve-draft — Approve AI draft
// ---------------------------------------------------------------------------
adminRouter.post("/tickets/:id/approve-draft", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return res.status(400).json({ ok: false, error: "Invalid ticket ID" });

    const { messageId } = req.body;
    if (!messageId || typeof messageId !== "number") {
      return res.status(400).json({ ok: false, error: "messageId is required" });
    }

    const result = await SupportAIEngine.approveDraft(ticketId, messageId, req.admin!.id);
    if (!result.ok) {
      return res.status(404).json({ ok: false, error: "Draft not found or already approved" });
    }

    await logAdminAction(
      req.admin!.id, "approve_ai_draft", "ticket_message", String(messageId),
      null, null, clientIp(req)
    );

    res.json({ ok: true });
  } catch (err) {
    logError("[admin] POST /tickets/:id/approve-draft error:", err);
    res.status(500).json({ ok: false, error: "Failed to approve draft" });
  }
});

// ---------------------------------------------------------------------------
// 17. POST /admin/tickets/:id/classify — Auto-classify ticket
// ---------------------------------------------------------------------------
adminRouter.post("/tickets/:id/classify", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return res.status(400).json({ ok: false, error: "Invalid ticket ID" });

    const result = await SupportAIEngine.classifyTicket(ticketId);
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: "Classification failed" });
    }

    await logAdminAction(
      req.admin!.id, "classify_ticket", "ticket", String(ticketId),
      null, JSON.stringify(result), clientIp(req)
    );

    res.json({ ok: true, data: { category: result.category, priority: result.priority, confidence: result.confidence } });
  } catch (err) {
    logError("[admin] POST /tickets/:id/classify error:", err);
    res.status(500).json({ ok: false, error: "Failed to classify ticket" });
  }
});

// ---------------------------------------------------------------------------
// 18. GET /admin/tickets/:id/messages — Get ticket messages
// ---------------------------------------------------------------------------
adminRouter.get("/tickets/:id/messages", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const ticketId = parseInt(req.params.id);
    if (isNaN(ticketId)) return res.status(400).json({ ok: false, error: "Invalid ticket ID" });

    const { rows } = await pgPool.query(
      `SELECT id, ticket_id, sender_type, sender_id, content, is_ai_draft, approved_by, created_at
       FROM ticket_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [ticketId]
    );

    res.json({ ok: true, data: { messages: rows } });
  } catch (err) {
    logError("[admin] GET /tickets/:id/messages error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch messages" });
  }
});

// ---------------------------------------------------------------------------
// 19. GET /admin/support/escalation-rules — escalation rules
// ---------------------------------------------------------------------------
adminRouter.get("/support/escalation-rules", requireRole("support"), async (req: Request, res: Response) => {
  try {
    await ensureSupportSettingsSchema();
    const { rows } = await pgPool.query(
      `SELECT id, condition_type, condition_value, action, is_active, created_at
       FROM support_escalation_rules
       ORDER BY created_at DESC`
    );
    res.json({ ok: true, data: { rules: rows } });
  } catch (err) {
    logError("[admin] GET /support/escalation-rules error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch escalation rules" });
  }
});

// ---------------------------------------------------------------------------
// 20. POST /admin/support/escalation-rules — create escalation rule
// ---------------------------------------------------------------------------
adminRouter.post("/support/escalation-rules", requireRole("support"), async (req: Request, res: Response) => {
  try {
    await ensureSupportSettingsSchema();
    const { condition_type, condition_value, action } = req.body ?? {};

    if (!condition_type || !condition_value || !action) {
      return res.status(400).json({ ok: false, error: "condition_type, condition_value, action are required" });
    }

    if (
      typeof condition_type !== "string" ||
      typeof condition_value !== "string" ||
      typeof action !== "string" ||
      condition_type.length > 100 ||
      condition_value.length > 300 ||
      action.length > 100
    ) {
      return res.status(400).json({ ok: false, error: "Invalid rule payload" });
    }

    const { rows } = await pgPool.query(
      `INSERT INTO support_escalation_rules (condition_type, condition_value, action, is_active, created_by)
       VALUES ($1, $2, $3, true, $4)
       RETURNING id, condition_type, condition_value, action, is_active, created_at`,
      [condition_type.trim(), condition_value.trim(), action.trim(), req.admin!.id]
    );

    await logAdminAction(
      req.admin!.id,
      "create_support_rule",
      "support_escalation_rule",
      String(rows[0].id),
      null,
      JSON.stringify({ condition_type, condition_value, action }),
      clientIp(req)
    );

    res.json({ ok: true, data: { rule: rows[0] } });
  } catch (err) {
    logError("[admin] POST /support/escalation-rules error:", err);
    res.status(500).json({ ok: false, error: "Failed to create escalation rule" });
  }
});

// ---------------------------------------------------------------------------
// 21. PATCH /admin/support/escalation-rules/:id — update escalation rule
// ---------------------------------------------------------------------------
adminRouter.patch("/support/escalation-rules/:id", requireRole("support"), async (req: Request, res: Response) => {
  try {
    await ensureSupportSettingsSchema();
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid rule ID" });

    const { condition_type, condition_value, action, is_active } = req.body ?? {};
    const fields: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (condition_type !== undefined) {
      if (typeof condition_type !== "string" || condition_type.length > 100) {
        return res.status(400).json({ ok: false, error: "Invalid condition_type" });
      }
      fields.push(`condition_type = $${p++}`);
      params.push(condition_type.trim());
    }
    if (condition_value !== undefined) {
      if (typeof condition_value !== "string" || condition_value.length > 300) {
        return res.status(400).json({ ok: false, error: "Invalid condition_value" });
      }
      fields.push(`condition_value = $${p++}`);
      params.push(condition_value.trim());
    }
    if (action !== undefined) {
      if (typeof action !== "string" || action.length > 100) {
        return res.status(400).json({ ok: false, error: "Invalid action" });
      }
      fields.push(`action = $${p++}`);
      params.push(action.trim());
    }
    if (is_active !== undefined) {
      if (typeof is_active !== "boolean") {
        return res.status(400).json({ ok: false, error: "Invalid is_active" });
      }
      fields.push(`is_active = $${p++}`);
      params.push(is_active);
    }

    if (!fields.length) {
      return res.status(400).json({ ok: false, error: "No valid fields to update" });
    }

    fields.push(`updated_at = NOW()`);
    params.push(id);
    const { rows } = await pgPool.query(
      `UPDATE support_escalation_rules
       SET ${fields.join(", ")}
       WHERE id = $${p}
       RETURNING id, condition_type, condition_value, action, is_active, created_at`,
      params
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: "Rule not found" });

    await logAdminAction(
      req.admin!.id,
      "update_support_rule",
      "support_escalation_rule",
      String(id),
      null,
      JSON.stringify({ condition_type, condition_value, action, is_active }),
      clientIp(req)
    );

    res.json({ ok: true, data: { rule: rows[0] } });
  } catch (err) {
    logError("[admin] PATCH /support/escalation-rules/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to update escalation rule" });
  }
});

// ---------------------------------------------------------------------------
// 22. DELETE /admin/support/escalation-rules/:id — delete escalation rule
// ---------------------------------------------------------------------------
adminRouter.delete("/support/escalation-rules/:id", requireRole("support"), async (req: Request, res: Response) => {
  try {
    await ensureSupportSettingsSchema();
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid rule ID" });

    const { rowCount } = await pgPool.query(`DELETE FROM support_escalation_rules WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: "Rule not found" });

    await logAdminAction(
      req.admin!.id,
      "delete_support_rule",
      "support_escalation_rule",
      String(id),
      null,
      null,
      clientIp(req)
    );

    res.json({ ok: true });
  } catch (err) {
    logError("[admin] DELETE /support/escalation-rules/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to delete escalation rule" });
  }
});

// ---------------------------------------------------------------------------
// 23. GET /admin/support/auto-send-config — auto send config
// ---------------------------------------------------------------------------
adminRouter.get("/support/auto-send-config", requireRole("support"), async (_req: Request, res: Response) => {
  try {
    await ensureSupportSettingsSchema();
    const { rows } = await pgPool.query(
      `SELECT enabled, confidence_threshold FROM support_auto_send_config WHERE id = 1 LIMIT 1`
    );
    const config = rows[0] ?? { enabled: false, confidence_threshold: 0.85 };
    res.json({
      ok: true,
      data: {
        enabled: Boolean(config.enabled),
        confidenceThreshold: Number(config.confidence_threshold ?? 0.85),
      },
    });
  } catch (err) {
    logError("[admin] GET /support/auto-send-config error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch auto-send config" });
  }
});

// ---------------------------------------------------------------------------
// 24. PATCH /admin/support/auto-send-config — update auto send config
// ---------------------------------------------------------------------------
adminRouter.patch("/support/auto-send-config", requireRole("support"), async (req: Request, res: Response) => {
  try {
    await ensureSupportSettingsSchema();
    const { enabled, confidenceThreshold } = req.body ?? {};
    const fields: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") return res.status(400).json({ ok: false, error: "enabled must be boolean" });
      fields.push(`enabled = $${p++}`);
      params.push(enabled);
    }

    if (confidenceThreshold !== undefined) {
      const parsed = Number(confidenceThreshold);
      if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 0.99) {
        return res.status(400).json({ ok: false, error: "confidenceThreshold must be between 0.5 and 0.99" });
      }
      fields.push(`confidence_threshold = $${p++}`);
      params.push(parsed);
    }

    if (!fields.length) {
      return res.status(400).json({ ok: false, error: "No valid fields to update" });
    }

    fields.push(`updated_by = $${p++}`);
    params.push(req.admin!.id);
    fields.push(`updated_at = NOW()`);

    await pgPool.query(
      `UPDATE support_auto_send_config SET ${fields.join(", ")} WHERE id = 1`,
      params
    );

    const { rows } = await pgPool.query(
      `SELECT enabled, confidence_threshold FROM support_auto_send_config WHERE id = 1 LIMIT 1`
    );
    const config = rows[0] ?? { enabled: false, confidence_threshold: 0.85 };

    await logAdminAction(
      req.admin!.id,
      "update_support_auto_send_config",
      "support_auto_send_config",
      "1",
      null,
      JSON.stringify({ enabled, confidenceThreshold }),
      clientIp(req)
    );

    res.json({
      ok: true,
      data: {
        enabled: Boolean(config.enabled),
        confidenceThreshold: Number(config.confidence_threshold ?? 0.85),
      },
    });
  } catch (err) {
    logError("[admin] PATCH /support/auto-send-config error:", err);
    res.status(500).json({ ok: false, error: "Failed to update auto-send config" });
  }
});

// ---------------------------------------------------------------------------
// 25. GET /admin/support/faq-stats — FAQ stats
// ---------------------------------------------------------------------------
adminRouter.get("/support/faq-stats", requireRole("support"), async (_req: Request, res: Response) => {
  try {
    const { rows: totalRows } = await pgPool.query(
      `SELECT COUNT(*)::int AS total FROM support_knowledge WHERE is_active = true`
    );
    const totalCount = totalRows[0]?.total ?? 0;

    const { rows: mostUsed } = await pgPool.query(
      `SELECT k.question,
              COALESCE(u.hit_count, 0)::int AS "hitCount"
       FROM support_knowledge k
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS hit_count
         FROM ticket_messages tm
         WHERE tm.is_ai_draft = true
           AND tm.content ILIKE ('%' || k.question || '%')
       ) u ON true
       WHERE k.is_active = true
       ORDER BY u.hit_count DESC, k.updated_at DESC
       LIMIT 5`
    );

    res.json({ ok: true, data: { totalCount, mostUsed } });
  } catch (err) {
    logError("[admin] GET /support/faq-stats error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch FAQ stats" });
  }
});

// ---------------------------------------------------------------------------
// 26. GET /admin/knowledge — List knowledge base entries
// ---------------------------------------------------------------------------
adminRouter.get("/knowledge", requireRole("support"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const category = req.query.category as string | undefined;

    const result = await SupportKnowledgeRepo.list(category, page, limit);
    res.json({ ok: true, data: result });
  } catch (err) {
    logError("[admin] GET /knowledge error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch knowledge base" });
  }
});

// ---------------------------------------------------------------------------
// 20. POST /admin/knowledge — Create knowledge entry
// ---------------------------------------------------------------------------
adminRouter.post("/knowledge", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { category, question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ ok: false, error: "question and answer are required" });
    }
    if (typeof question !== "string" || question.length > 5000) {
      return res.status(400).json({ ok: false, error: "question too long (max 5000)" });
    }
    if (typeof answer !== "string" || answer.length > 20000) {
      return res.status(400).json({ ok: false, error: "answer too long (max 20000)" });
    }
    const VALID_KB_CATEGORIES = ["general", "bug", "billing", "account", "feature"];
    const safeCategory = VALID_KB_CATEGORIES.includes(category) ? category : "general";

    const entry = await SupportKnowledgeRepo.create({
      category: safeCategory,
      question,
      answer,
      created_by: req.admin!.id,
    });

    await logAdminAction(
      req.admin!.id, "create_knowledge", "knowledge", String(entry.id),
      null, JSON.stringify({ category, question: question.slice(0, 100) }), clientIp(req)
    );

    res.json({ ok: true, data: { entry } });
  } catch (err) {
    logError("[admin] POST /knowledge error:", err);
    res.status(500).json({ ok: false, error: "Failed to create knowledge entry" });
  }
});

// ---------------------------------------------------------------------------
// 21. PATCH /admin/knowledge/:id — Update knowledge entry
// ---------------------------------------------------------------------------
adminRouter.patch("/knowledge/:id", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid ID" });

    const { category, question, answer, is_active } = req.body;
    const updated = await SupportKnowledgeRepo.update(id, { category, question, answer, is_active });

    if (!updated) return res.status(404).json({ ok: false, error: "Entry not found" });

    await logAdminAction(
      req.admin!.id, "update_knowledge", "knowledge", String(id),
      null, JSON.stringify({ category, question: question?.slice(0, 100) }), clientIp(req)
    );

    res.json({ ok: true, data: { entry: updated } });
  } catch (err) {
    logError("[admin] PATCH /knowledge/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to update knowledge entry" });
  }
});

// ---------------------------------------------------------------------------
// 22. DELETE /admin/knowledge/:id — Soft-delete knowledge entry
// ---------------------------------------------------------------------------
adminRouter.delete("/knowledge/:id", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid ID" });

    const deleted = await SupportKnowledgeRepo.softDelete(id);
    if (!deleted) return res.status(404).json({ ok: false, error: "Entry not found" });

    await logAdminAction(
      req.admin!.id, "delete_knowledge", "knowledge", String(id),
      null, null, clientIp(req)
    );

    res.json({ ok: true });
  } catch (err) {
    logError("[admin] DELETE /knowledge/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to delete knowledge entry" });
  }
});

// ---------------------------------------------------------------------------
// 23. GET /admin/stats/revenue/daily — Daily revenue chart data
// ---------------------------------------------------------------------------
adminRouter.get("/stats/revenue/daily", requireRole("billing_manager"), async (req: Request, res: Response) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days as string) || 30));

    const { rows } = await pgPool.query(
      `SELECT DATE(created_at) as date,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as revenue,
              COUNT(*) as tx_count
       FROM credit_transactions
       WHERE type = 'purchase' AND created_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [days]
    );

    res.json({ ok: true, data: { daily: rows, days } });
  } catch (err) {
    logError("[admin] GET /stats/revenue/daily error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch daily revenue" });
  }
});

// ---------------------------------------------------------------------------
// 24. GET /admin/stats/customers — Customer overview stats
// ---------------------------------------------------------------------------
adminRouter.get("/stats/customers", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    // User growth by month (MySQL)
    const [monthlyGrowth]: any = await mysqlPool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as new_users
       FROM users
       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
       ORDER BY month DESC
       LIMIT 12`
    );

    // Plan distribution (MySQL)
    const [planDist]: any = await mysqlPool.query(
      `SELECT COALESCE(plan_id, 'free') as plan, COUNT(*) as count
       FROM users GROUP BY plan_id`
    );

    // Auth provider distribution (MySQL)
    const [authDist]: any = await mysqlPool.query(
      `SELECT COALESCE(auth_provider, 'unknown') as provider, COUNT(*) as count
       FROM users GROUP BY auth_provider`
    );

    // Active users (last 7/30 days) (MySQL)
    const [[active7]]: any = await mysqlPool.query(
      `SELECT COUNT(*) as count FROM users WHERE updated_at >= NOW() - INTERVAL 7 DAY`
    );
    const [[active30]]: any = await mysqlPool.query(
      `SELECT COUNT(*) as count FROM users WHERE updated_at >= NOW() - INTERVAL 30 DAY`
    );
    const [[totalUsers]]: any = await mysqlPool.query(`SELECT COUNT(*) as count FROM users`);

    res.json({
      ok: true,
      data: {
        totalUsers: totalUsers?.count ?? 0,
        active7d: active7?.count ?? 0,
        active30d: active30?.count ?? 0,
        monthlyGrowth,
        planDistribution: planDist,
        authDistribution: authDist,
      },
    });
  } catch (err) {
    logError("[admin] GET /stats/customers error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch customer stats" });
  }
});

// ---------------------------------------------------------------------------
// 25. GET /admin/customers — Customer list with search/filter
// ---------------------------------------------------------------------------
adminRouter.get("/customers", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const search = (req.query.search as string) || "";
    const planFilter = (req.query.plan as string) || "";
    const sortBy = (req.query.sort as string) || "created_at";
    const sortDir = (req.query.dir as string) === "asc" ? "ASC" : "DESC";

    const validSorts = ["created_at", "updated_at", "name", "email", "plan_id"];
    const sort = validSorts.includes(sortBy) ? sortBy : "created_at";

    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      conditions.push("(email LIKE ? OR name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    if (planFilter) {
      conditions.push("plan_id = ?");
      params.push(planFilter);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [[countRow]]: any = await mysqlPool.query(
      `SELECT COUNT(*) AS total FROM users ${where}`, params
    );

    const [rows]: any = await mysqlPool.query(
      `SELECT id, email, name, plan_id, role, auth_provider, credits,
              daily_usage, monthly_usage, created_at, updated_at
       FROM users ${where}
       ORDER BY ${sort} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ ok: true, data: { customers: rows, total: countRow?.total ?? 0, page, limit } });
  } catch (err) {
    logError("[admin] GET /customers error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch customers" });
  }
});

// ---------------------------------------------------------------------------
// 26. GET /admin/overview/kpi — Unified KPI overview
// ---------------------------------------------------------------------------
adminRouter.get("/overview/kpi", requireRole("viewer"), async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) || "7d";
    const dailyMatch = range.match(/^(\d{1,3})d$/);
    const hourlyMatch = range.match(/^(\d{1,3})h$/);

    if (!dailyMatch && !hourlyMatch) {
      return res.status(400).json({ ok: false, error: "Invalid range. Use Nd or Nh (e.g. 7d, 24h)" });
    }

    if (dailyMatch) {
      const days = Math.min(365, Math.max(1, parseInt(dailyMatch[1], 10)));
      const { rows } = await pgPool.query(
        `SELECT day::text AS bucket, dau, mau, total_requests, total_tokens,
                api_success_rate, stream_interrupt_rate, mrr, gross_revenue, refund_amount
         FROM admin_kpi_daily
         WHERE day >= CURRENT_DATE - ($1::int - 1)
         ORDER BY day ASC`,
        [days]
      );
      const latest = rows[rows.length - 1] ?? null;
      return res.json({ ok: true, data: { range, granularity: "day", series: rows, latest } });
    }

    const hours = Math.min(720, Math.max(1, parseInt(hourlyMatch![1], 10)));
    const { rows } = await pgPool.query(
      `SELECT bucket_at::text AS bucket, dau, mau, total_requests, total_tokens,
              api_success_rate, stream_interrupt_rate, mrr, gross_revenue, refund_amount
       FROM admin_kpi_hourly
       WHERE bucket_at >= NOW() - ($1::int * INTERVAL '1 hour')
       ORDER BY bucket_at ASC`,
      [hours]
    );
    const latest = rows[rows.length - 1] ?? null;
    return res.json({ ok: true, data: { range, granularity: "hour", series: rows, latest } });
  } catch (err) {
    logError("[admin] GET /overview/kpi error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch overview kpi" });
  }
});

// ---------------------------------------------------------------------------
// 27. GET /admin/billing/verification-logs — verification trace
// ---------------------------------------------------------------------------
adminRouter.get("/billing/verification-logs", requireRole("billing_manager"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const status = (req.query.status as string) || "";
    const platform = (req.query.platform as string) || "";

    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (status) {
      conditions.push(`verification_status = $${p++}`);
      params.push(status);
    }
    if (platform) {
      conditions.push(`platform = $${p++}`);
      params.push(platform);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: countRows } = await pgPool.query(
      `SELECT COUNT(*)::int AS total FROM billing_verification_log ${where}`,
      params
    );
    const total = countRows[0]?.total ?? 0;

    const { rows } = await pgPool.query(
      `SELECT id, platform, provider, product_type, product_id, order_id, purchase_token,
              user_id, workspace_id, verification_status, reason_code, latency_ms, created_at
       FROM billing_verification_log ${where}
       ORDER BY created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    res.json({ ok: true, data: { logs: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /billing/verification-logs error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch billing verification logs" });
  }
});

// ---------------------------------------------------------------------------
// 28. GET /admin/billing/credit-ledger — credit ledger
// ---------------------------------------------------------------------------
adminRouter.get("/billing/credit-ledger", requireRole("billing_manager"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const userId = req.query.user_id ? parseInt(req.query.user_id as string, 10) : null;

    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (userId && Number.isFinite(userId)) {
      conditions.push(`user_id = $${p++}`);
      params.push(userId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: countRows } = await pgPool.query(
      `SELECT COUNT(*)::int AS total FROM credit_ledger ${where}`,
      params
    );
    const total = countRows[0]?.total ?? 0;

    const { rows } = await pgPool.query(
      `SELECT id, workspace_id, user_id, direction, reason, amount, balance_after, currency,
              source_type, source_id, idempotency_key, metadata, created_by_admin_id, created_at
       FROM credit_ledger ${where}
       ORDER BY id DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    res.json({ ok: true, data: { ledger: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /billing/credit-ledger error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch credit ledger" });
  }
});

// ---------------------------------------------------------------------------
// 29. POST /admin/billing/credits/adjust — idempotent adjustment
// ---------------------------------------------------------------------------
adminRouter.post("/billing/credits/adjust", requireRole("billing_manager"), async (req: Request, res: Response) => {
  const idemHeader = (req.headers["idempotency-key"] as string | undefined)?.trim();
  if (!idemHeader) {
    return res.status(400).json({ ok: false, error: "Idempotency-Key header is required" });
  }

  const { user_id, workspace_id, direction, amount, reason, source_type, source_id, metadata } = req.body ?? {};
  const parsedUserId = Number(user_id);
  const parsedWorkspaceId = workspace_id == null ? null : Number(workspace_id);
  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) {
    return res.status(400).json({ ok: false, error: "user_id is required" });
  }
  if (workspace_id != null && (!Number.isFinite(parsedWorkspaceId!) || parsedWorkspaceId! <= 0)) {
    return res.status(400).json({ ok: false, error: "workspace_id must be positive number" });
  }
  if (direction !== "credit" && direction !== "debit") {
    return res.status(400).json({ ok: false, error: "direction must be credit or debit" });
  }
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ ok: false, error: "amount must be > 0" });
  }
  if (!reason || typeof reason !== "string" || reason.length > 64) {
    return res.status(400).json({ ok: false, error: "reason is required (max 64 chars)" });
  }

  const scope = "credit_adjustment";
  const keyHash = sha256(idemHeader);
  const fingerprint = sha256(
    JSON.stringify({
      user_id: parsedUserId,
      workspace_id: parsedWorkspaceId,
      direction,
      amount: parsedAmount,
      reason,
      source_type: source_type ?? null,
      source_id: source_id ?? null,
    })
  );

  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");

    const { rows: insertedRows } = await client.query(
      `INSERT INTO admin_idempotency_keys (scope, key_hash, request_fingerprint, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
       ON CONFLICT (scope, key_hash) DO NOTHING
       RETURNING id`,
      [scope, keyHash, fingerprint]
    );

    if (!insertedRows.length) {
      const { rows: existingRows } = await client.query(
        `SELECT request_fingerprint, response_code, response_body
         FROM admin_idempotency_keys
         WHERE scope = $1 AND key_hash = $2
         LIMIT 1
         FOR UPDATE`,
        [scope, keyHash]
      );
      const existing = existingRows[0];
      if (!existing) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "Idempotency conflict, retry required" });
      }
      if (existing.request_fingerprint !== fingerprint) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "Idempotency key already used with different payload" });
      }
      if (existing.response_body) {
        await client.query("COMMIT");
        return res.status(existing.response_code || 200).json(existing.response_body);
      }
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Request already in progress for this key" });
    }

    const { rows: balRows } = await client.query(
      `SELECT balance_after
       FROM credit_ledger
       WHERE user_id = $1
         AND COALESCE(workspace_id, -1) = COALESCE($2::bigint, -1)
       ORDER BY id DESC
       LIMIT 1`,
      [parsedUserId, parsedWorkspaceId]
    );
    const previousBalance = Number(balRows[0]?.balance_after ?? 0);
    const nextBalance = direction === "credit" ? previousBalance + parsedAmount : previousBalance - parsedAmount;
    if (nextBalance < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Insufficient balance for debit adjustment" });
    }

    const ledgerIdempotency = `${scope}:${keyHash}`;
    const safeMetadata = metadata && typeof metadata === "object" ? metadata : {};

    const { rows: ledgerRows } = await client.query(
      `INSERT INTO credit_ledger (
         workspace_id, user_id, direction, reason, amount, balance_after, currency,
         source_type, source_id, idempotency_key, metadata, created_by_admin_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $8, $9, $10::jsonb, $11)
       RETURNING id, workspace_id, user_id, direction, reason, amount, balance_after, created_at`,
      [
        parsedWorkspaceId,
        parsedUserId,
        direction,
        reason,
        parsedAmount,
        nextBalance,
        source_type ?? "admin",
        source_id ?? null,
        ledgerIdempotency,
        JSON.stringify(safeMetadata),
        req.admin!.id,
      ]
    );
    const entry = ledgerRows[0];

    await client.query(
      `INSERT INTO audit_outbox (aggregate_type, aggregate_id, action, actor_admin_id, payload)
       VALUES ('credit_ledger', $1, 'billing.credit.adjust', $2, $3::jsonb)`,
      [String(entry.id), req.admin!.id, JSON.stringify(entry)]
    );

    const responseBody = { ok: true, data: { entry } };
    await client.query(
      `UPDATE admin_idempotency_keys
       SET response_code = 200, response_body = $1::jsonb
       WHERE scope = $2 AND key_hash = $3`,
      [JSON.stringify(responseBody), scope, keyHash]
    );

    await client.query("COMMIT");

    await logAdminAction(
      req.admin!.id,
      "billing_credit_adjust",
      "credit_ledger",
      String(entry.id),
      null,
      JSON.stringify({
        user_id: parsedUserId,
        workspace_id: parsedWorkspaceId,
        direction,
        amount: parsedAmount,
        reason,
      }),
      clientIp(req)
    );

    return res.json(responseBody);
  } catch (err) {
    await client.query("ROLLBACK");
    logError("[admin] POST /billing/credits/adjust error:", err);
    return res.status(500).json({ ok: false, error: "Failed to adjust credits" });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 30. GET /admin/feature-flags — list flags
// ---------------------------------------------------------------------------
adminRouter.get("/feature-flags", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const search = (req.query.search as string) || "";
    const params: any[] = [];
    let where = "";
    if (search) {
      where = "WHERE flag_key ILIKE $1";
      params.push(`%${search}%`);
    }
    const { rows } = await pgPool.query(
      `SELECT id, flag_key, description, enabled, rollout_percent, target_platforms,
              targeting_rules, kill_switch, updated_by_admin_id, created_at, updated_at
       FROM feature_flags ${where}
       ORDER BY updated_at DESC`,
      params
    );
    res.json({ ok: true, data: { flags: rows } });
  } catch (err) {
    logError("[admin] GET /feature-flags error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch feature flags" });
  }
});

// ---------------------------------------------------------------------------
// 31. POST /admin/feature-flags — create flag
// ---------------------------------------------------------------------------
adminRouter.post("/feature-flags", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { flag_key, description, enabled, rollout_percent, target_platforms, targeting_rules, kill_switch, reason } = req.body ?? {};
    if (!flag_key || typeof flag_key !== "string" || flag_key.length > 120) {
      return res.status(400).json({ ok: false, error: "flag_key is required (max 120)" });
    }
    const rollout = rollout_percent == null ? 0 : Number(rollout_percent);
    if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100) {
      return res.status(400).json({ ok: false, error: "rollout_percent must be between 0 and 100" });
    }

    const { rows } = await pgPool.query(
      `INSERT INTO feature_flags (
         flag_key, description, enabled, rollout_percent, target_platforms, targeting_rules, kill_switch, updated_by_admin_id
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
       RETURNING *`,
      [
        flag_key.trim(),
        description ?? null,
        Boolean(enabled),
        rollout,
        JSON.stringify(Array.isArray(target_platforms) ? target_platforms : []),
        JSON.stringify(targeting_rules && typeof targeting_rules === "object" ? targeting_rules : {}),
        Boolean(kill_switch),
        req.admin!.id,
      ]
    );
    const flag = rows[0];

    await pgPool.query(
      `INSERT INTO feature_flag_audit (flag_key, action, before_value, after_value, reason, actor_admin_id)
       VALUES ($1, 'create', NULL, $2::jsonb, $3, $4)`,
      [flag.flag_key, JSON.stringify(flag), reason ?? null, req.admin!.id]
    );

    await logAdminAction(req.admin!.id, "create_feature_flag", "feature_flag", flag.flag_key, null, JSON.stringify(flag), clientIp(req));
    res.json({ ok: true, data: { flag } });
  } catch (err: any) {
    if (String(err?.message || "").includes("duplicate key")) {
      return res.status(409).json({ ok: false, error: "flag_key already exists" });
    }
    logError("[admin] POST /feature-flags error:", err);
    res.status(500).json({ ok: false, error: "Failed to create feature flag" });
  }
});

// ---------------------------------------------------------------------------
// 32. PATCH /admin/feature-flags/:flagKey — update flag
// ---------------------------------------------------------------------------
adminRouter.patch("/feature-flags/:flagKey", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const flagKey = req.params.flagKey;
    const { description, enabled, rollout_percent, target_platforms, targeting_rules, kill_switch, reason } = req.body ?? {};
    const { rows: beforeRows } = await pgPool.query(`SELECT * FROM feature_flags WHERE flag_key = $1 LIMIT 1`, [flagKey]);
    if (!beforeRows.length) return res.status(404).json({ ok: false, error: "Feature flag not found" });
    const before = beforeRows[0];

    const sets: string[] = [];
    const vals: any[] = [];
    let p = 1;
    if (description !== undefined) { sets.push(`description = $${p++}`); vals.push(description); }
    if (enabled !== undefined) { sets.push(`enabled = $${p++}`); vals.push(Boolean(enabled)); }
    if (rollout_percent !== undefined) {
      const rollout = Number(rollout_percent);
      if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100) {
        return res.status(400).json({ ok: false, error: "rollout_percent must be between 0 and 100" });
      }
      sets.push(`rollout_percent = $${p++}`); vals.push(rollout);
    }
    if (target_platforms !== undefined) { sets.push(`target_platforms = $${p++}::jsonb`); vals.push(JSON.stringify(target_platforms)); }
    if (targeting_rules !== undefined) { sets.push(`targeting_rules = $${p++}::jsonb`); vals.push(JSON.stringify(targeting_rules)); }
    if (kill_switch !== undefined) { sets.push(`kill_switch = $${p++}`); vals.push(Boolean(kill_switch)); }
    if (!sets.length) return res.status(400).json({ ok: false, error: "No valid fields to update" });

    sets.push(`updated_by_admin_id = $${p++}`); vals.push(req.admin!.id);
    sets.push(`updated_at = NOW()`);
    vals.push(flagKey);
    const { rows } = await pgPool.query(
      `UPDATE feature_flags SET ${sets.join(", ")} WHERE flag_key = $${p} RETURNING *`,
      vals
    );
    const after = rows[0];

    await pgPool.query(
      `INSERT INTO feature_flag_audit (flag_key, action, before_value, after_value, reason, actor_admin_id)
       VALUES ($1, 'update', $2::jsonb, $3::jsonb, $4, $5)`,
      [flagKey, JSON.stringify(before), JSON.stringify(after), reason ?? null, req.admin!.id]
    );
    await logAdminAction(req.admin!.id, "update_feature_flag", "feature_flag", flagKey, JSON.stringify(before), JSON.stringify(after), clientIp(req));
    res.json({ ok: true, data: { flag: after } });
  } catch (err) {
    logError("[admin] PATCH /feature-flags/:flagKey error:", err);
    res.status(500).json({ ok: false, error: "Failed to update feature flag" });
  }
});

// ---------------------------------------------------------------------------
// 33. GET /admin/incidents — list incidents
// ---------------------------------------------------------------------------
adminRouter.get("/incidents", requireRole("viewer"), async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || "";
    const severity = (req.query.severity as string) || "";
    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (status) { conditions.push(`status = $${p++}`); params.push(status); }
    if (severity) { conditions.push(`severity = $${p++}`); params.push(severity); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pgPool.query(
      `SELECT id, incident_key, severity, status, title, description, affected_scope,
              started_at, acknowledged_at, mitigated_at, resolved_at, owner_admin_id, created_at, updated_at
       FROM incident_timeline ${where}
       ORDER BY started_at DESC`,
      params
    );
    res.json({ ok: true, data: { incidents: rows } });
  } catch (err) {
    logError("[admin] GET /incidents error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch incidents" });
  }
});

// ---------------------------------------------------------------------------
// 34. POST /admin/incidents — create incident
// ---------------------------------------------------------------------------
adminRouter.post("/incidents", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { incident_key, severity, title, description, affected_scope, owner_admin_id } = req.body ?? {};
    if (!incident_key || typeof incident_key !== "string") return res.status(400).json({ ok: false, error: "incident_key is required" });
    if (!["SEV1", "SEV2", "SEV3"].includes(severity)) return res.status(400).json({ ok: false, error: "severity must be SEV1|SEV2|SEV3" });
    if (!title || typeof title !== "string") return res.status(400).json({ ok: false, error: "title is required" });

    const { rows } = await pgPool.query(
      `INSERT INTO incident_timeline (
         incident_key, severity, status, title, description, affected_scope, owner_admin_id
       )
       VALUES ($1, $2, 'open', $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [
        incident_key.trim(),
        severity,
        title.trim(),
        description ?? null,
        JSON.stringify(affected_scope && typeof affected_scope === "object" ? affected_scope : {}),
        owner_admin_id ?? req.admin!.id,
      ]
    );
    const incident = rows[0];
    await logAdminAction(req.admin!.id, "create_incident", "incident", incident.incident_key, null, JSON.stringify(incident), clientIp(req));
    res.json({ ok: true, data: { incident } });
  } catch (err: any) {
    if (String(err?.message || "").includes("duplicate key")) {
      return res.status(409).json({ ok: false, error: "incident_key already exists" });
    }
    logError("[admin] POST /incidents error:", err);
    res.status(500).json({ ok: false, error: "Failed to create incident" });
  }
});

// ---------------------------------------------------------------------------
// 35. PATCH /admin/incidents/:incidentKey — update incident
// ---------------------------------------------------------------------------
adminRouter.patch("/incidents/:incidentKey", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const incidentKey = req.params.incidentKey;
    const { status, title, description, severity, owner_admin_id } = req.body ?? {};
    const sets: string[] = [];
    const vals: any[] = [];
    let p = 1;

    if (status !== undefined) {
      if (!["open", "acknowledged", "mitigated", "resolved", "closed"].includes(status)) {
        return res.status(400).json({ ok: false, error: "Invalid status" });
      }
      sets.push(`status = $${p++}`); vals.push(status);
      if (status === "acknowledged") sets.push(`acknowledged_at = COALESCE(acknowledged_at, NOW())`);
      if (status === "mitigated") sets.push(`mitigated_at = COALESCE(mitigated_at, NOW())`);
      if (status === "resolved" || status === "closed") sets.push(`resolved_at = COALESCE(resolved_at, NOW())`);
    }
    if (severity !== undefined) {
      if (!["SEV1", "SEV2", "SEV3"].includes(severity)) return res.status(400).json({ ok: false, error: "Invalid severity" });
      sets.push(`severity = $${p++}`); vals.push(severity);
    }
    if (title !== undefined) { sets.push(`title = $${p++}`); vals.push(title); }
    if (description !== undefined) { sets.push(`description = $${p++}`); vals.push(description); }
    if (owner_admin_id !== undefined) { sets.push(`owner_admin_id = $${p++}`); vals.push(owner_admin_id); }
    if (!sets.length) return res.status(400).json({ ok: false, error: "No valid fields to update" });
    sets.push(`updated_at = NOW()`);
    vals.push(incidentKey);

    const { rows } = await pgPool.query(
      `UPDATE incident_timeline SET ${sets.join(", ")} WHERE incident_key = $${p} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Incident not found" });
    const incident = rows[0];
    await logAdminAction(req.admin!.id, "update_incident", "incident", incidentKey, null, JSON.stringify(incident), clientIp(req));
    res.json({ ok: true, data: { incident } });
  } catch (err) {
    logError("[admin] PATCH /incidents/:incidentKey error:", err);
    res.status(500).json({ ok: false, error: "Failed to update incident" });
  }
});

// ---------------------------------------------------------------------------
// 36. GET /admin/security/events — list security events
// ---------------------------------------------------------------------------
adminRouter.get("/security/events", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const risk = (req.query.risk_level as string) || "";
    const userId = req.query.user_id ? parseInt(req.query.user_id as string, 10) : null;

    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (risk) { conditions.push(`risk_level = $${p++}`); params.push(risk); }
    if (userId && Number.isFinite(userId)) { conditions.push(`user_id = $${p++}`); params.push(userId); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: countRows } = await pgPool.query(`SELECT COUNT(*)::int AS total FROM security_event_log ${where}`, params);
    const total = countRows[0]?.total ?? 0;

    const { rows } = await pgPool.query(
      `SELECT id, event_type, risk_level, user_id, workspace_id, source_platform, signal, decision, action_taken, trace_id, created_at
       FROM security_event_log ${where}
       ORDER BY created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    res.json({ ok: true, data: { events: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /security/events error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch security events" });
  }
});

// ---------------------------------------------------------------------------
// 37. GET /admin/failures/board — cross-domain failure board
// ---------------------------------------------------------------------------
adminRouter.get("/failures/board", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const daysRaw = Number(req.query.days ?? 14);
    const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, Math.floor(daysRaw))) : 14;
    const sourceFilter = ((req.query.source as string) || "").trim().toLowerCase();
    const causeCodeFilter = ((req.query.cause_code as string) || "").trim();
    const dayFilter = ((req.query.day as string) || "").trim();
    const limitRaw = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(50, Math.floor(limitRaw))) : 200;

    const validSources = new Set(["stream_interrupt", "billing_verification", "invite_delivery", "invite_lifecycle"]);
    const safeSource = validSources.has(sourceFilter) ? sourceFilter : "";
    const safeDay = /^\d{4}-\d{2}-\d{2}$/.test(dayFilter) ? dayFilter : "";

    const filters: string[] = [];
    const params: any[] = [days];
    let p = 2;
    if (safeSource) {
      filters.push(`source = $${p++}`);
      params.push(safeSource);
    }
    if (causeCodeFilter) {
      filters.push(`cause_code = $${p++}`);
      params.push(causeCodeFilter);
    }
    if (safeDay) {
      filters.push(`date_trunc('day', event_at)::date = $${p++}::date`);
      params.push(safeDay);
    }
    const filteredWhere = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const failuresCte = `
      WITH stream_failures AS (
        SELECT
          occurred_at AS event_at,
          'stream_interrupt'::text AS source,
          COALESCE(
            NULLIF(payload->>'error_code', ''),
            NULLIF(payload->>'reason_code', ''),
            NULLIF(payload->>'reason', ''),
            NULLIF(payload->>'code', ''),
            CASE
              WHEN payload::text ILIKE '%ECONNREFUSED%' THEN 'ECONNREFUSED'
              WHEN payload::text ILIKE '%timeout%' THEN 'STREAM_TIMEOUT'
              WHEN payload::text ILIKE '%client_close%' THEN 'CLIENT_CLOSED'
              WHEN payload::text ILIKE '%response_error%' THEN 'RESPONSE_ERROR'
              WHEN payload::text ILIKE '%stream_exhausted%' THEN 'STREAM_EXHAUSTED'
              WHEN payload::text ILIKE '%exception%' THEN 'STREAM_EXCEPTION'
              ELSE NULL
            END,
            NULLIF(payload->>'kind', ''),
            'unknown_stream_failure'
          ) AS cause_code,
          trace_id::text AS trace_id,
          workspace_id::text AS workspace_ref,
          thread_id::text AS thread_ref,
          LEFT(payload::text, 500) AS detail
        FROM phase9_raw_event_log
        WHERE occurred_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND (
            payload::text ILIKE '%ECONNREFUSED%'
            OR payload::text ILIKE '%stream%'
            OR payload::text ILIKE '%abort%'
            OR payload::text ILIKE '%timeout%'
            OR payload::text ILIKE '%client_close%'
            OR payload::text ILIKE '%response_error%'
            OR payload::text ILIKE '%exception%'
            OR payload::text ILIKE '%failed%'
          )
      ),
      billing_failures AS (
        SELECT
          created_at AS event_at,
          'billing_verification'::text AS source,
          COALESCE(NULLIF(reason_code, ''), NULLIF(verification_status, ''), 'verification_failed') AS cause_code,
          NULL::text AS trace_id,
          workspace_id::text AS workspace_ref,
          NULL::text AS thread_ref,
          CONCAT(
            'platform=', platform,
            ', provider=', provider,
            ', order=', COALESCE(order_id, '-'),
            ', product=', COALESCE(product_id, '-'),
            ', status=', verification_status
          ) AS detail
        FROM billing_verification_log
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND LOWER(COALESCE(verification_status, '')) NOT IN ('verified', 'success', 'succeeded', 'ok', 'approved')
      ),
      invite_delivery_failures AS (
        SELECT
          l.created_at AS event_at,
          'invite_delivery'::text AS source,
          COALESCE(NULLIF(l.error_code, ''), 'invite_send_failed') AS cause_code,
          NULL::text AS trace_id,
          i.workspace_id::text AS workspace_ref,
          NULL::text AS thread_ref,
          CONCAT(
            'recipient=', l.recipient_email,
            ', provider=', l.provider,
            ', invitation_status=', COALESCE(i.status, '-'),
            ', message=', COALESCE(l.error_message, '')
          ) AS detail
        FROM workspace_invitation_email_delivery_logs l
        JOIN workspace_invitations i ON i.id = l.invitation_id
        WHERE l.created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND l.status = 'failed'
      ),
      invite_lifecycle_failures AS (
        SELECT
          COALESCE(expires_at, created_at) AS event_at,
          'invite_lifecycle'::text AS source,
          CASE
            WHEN status = 'expired' THEN 'invite_expired'
            WHEN status = 'revoked' THEN 'invite_revoked'
            WHEN status = 'pending_approval' AND created_at < NOW() - INTERVAL '7 day' THEN 'invite_stuck_pending_approval'
            ELSE 'invite_lifecycle_issue'
          END AS cause_code,
          NULL::text AS trace_id,
          workspace_id::text AS workspace_ref,
          NULL::text AS thread_ref,
          CONCAT('email=', email, ', status=', status, ', role=', role) AS detail
        FROM workspace_invitations
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND (
            status = 'expired'
            OR status = 'revoked'
            OR (status = 'pending_approval' AND created_at < NOW() - INTERVAL '7 day')
          )
      ),
      all_failures AS (
        SELECT * FROM stream_failures
        UNION ALL
        SELECT * FROM billing_failures
        UNION ALL
        SELECT * FROM invite_delivery_failures
        UNION ALL
        SELECT * FROM invite_lifecycle_failures
      )
    `;

    const { rows: summaryRows } = await pgPool.query(
      `${failuresCte}
       SELECT source, COUNT(*)::int AS count
       FROM all_failures
       ${filteredWhere}
       GROUP BY source
       ORDER BY count DESC`,
      params
    );

    const { rows: byDayRows } = await pgPool.query(
      `${failuresCte}
       SELECT date_trunc('day', event_at)::date::text AS day, source, cause_code, COUNT(*)::int AS count
       FROM all_failures
       ${filteredWhere}
       GROUP BY 1, 2, 3
       ORDER BY day DESC, count DESC`,
      params
    );

    const recentLimitParam = `$${params.length + 1}`;
    const { rows: recentRows } = await pgPool.query(
      `${failuresCte}
       SELECT event_at, source, cause_code, trace_id, workspace_ref, thread_ref, detail
       FROM all_failures
       ${filteredWhere}
       ORDER BY event_at DESC
       LIMIT ${recentLimitParam}`,
      [...params, limit]
    );

    const remediationHints: Record<string, string> = {
      ECONNREFUSED: "업스트림 엔드포인트/포트 헬스체크와 재시도 정책 점검",
      STREAM_TIMEOUT: "스트림 타임아웃/모델 지연 구간 점검",
      CLIENT_CLOSED: "앱 백그라운드 전환 시 SSE 종료 처리 및 재연결 UX 점검",
      RESPONSE_ERROR: "SSE 프록시(response buffering/idle timeout) 설정 점검",
      verification_failed: "구매 토큰/주문ID 매핑 및 provider 응답 원문 검증",
      invite_send_failed: "SMTP/SendGrid API key, sender domain, rate limit 점검",
      invite_expired: "초대 만료 기한/재발송 플로우 점검",
    };

    const byCause = byDayRows.reduce<Record<string, number>>((acc, row: any) => {
      const cause = String(row.cause_code ?? "unknown");
      acc[cause] = (acc[cause] ?? 0) + Number(row.count ?? 0);
      return acc;
    }, {});

    const topCauses = Object.entries(byCause)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([cause_code, count]) => ({
        cause_code,
        count,
        hint: remediationHints[cause_code] ?? null,
      }));

    res.json({
      ok: true,
      data: {
        days,
        source: safeSource || "all",
        filters: {
          source: safeSource || null,
          cause_code: causeCodeFilter || null,
          day: safeDay || null,
        },
        summary: summaryRows,
        byDay: byDayRows,
        topCauses,
        recent: recentRows,
      },
    });
  } catch (err) {
    logError("[admin] GET /failures/board error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch failure board" });
  }
});

// ---------------------------------------------------------------------------
// 38. GET /admin/data-subject-requests — list governance requests
// ---------------------------------------------------------------------------
adminRouter.get("/data-subject-requests", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = parsePagination(req);
    const status = (req.query.status as string) || "";
    const requestType = (req.query.request_type as string) || "";

    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;
    if (status) { conditions.push(`status = $${p++}`); params.push(status); }
    if (requestType) { conditions.push(`request_type = $${p++}`); params.push(requestType); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: countRows } = await pgPool.query(`SELECT COUNT(*)::int AS total FROM data_subject_request ${where}`, params);
    const total = countRows[0]?.total ?? 0;

    const { rows } = await pgPool.query(
      `SELECT id, request_type, status, user_id, workspace_id, requester_email, legal_basis,
              due_at, fulfilled_at, exported_artifact_url, notes, handled_by_admin_id, created_at, updated_at
       FROM data_subject_request ${where}
       ORDER BY created_at DESC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    res.json({ ok: true, data: { requests: rows, total, page, limit } });
  } catch (err) {
    logError("[admin] GET /data-subject-requests error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch data subject requests" });
  }
});

// ---------------------------------------------------------------------------
// 39. POST /admin/data-subject-requests — create request
// ---------------------------------------------------------------------------
adminRouter.post("/data-subject-requests", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { request_type, user_id, workspace_id, requester_email, legal_basis, due_at, notes } = req.body ?? {};
    if (!["export", "delete"].includes(request_type)) {
      return res.status(400).json({ ok: false, error: "request_type must be export|delete" });
    }
    const parsedUserId = Number(user_id);
    if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) {
      return res.status(400).json({ ok: false, error: "user_id is required" });
    }

    const { rows } = await pgPool.query(
      `INSERT INTO data_subject_request (
         request_type, status, user_id, workspace_id, requester_email, legal_basis, due_at, notes, handled_by_admin_id
       )
       VALUES ($1, 'requested', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        request_type,
        parsedUserId,
        workspace_id ?? null,
        requester_email ?? null,
        legal_basis ?? null,
        due_at ?? null,
        notes ?? null,
        req.admin!.id,
      ]
    );
    const requestRow = rows[0];
    await logAdminAction(req.admin!.id, "create_data_subject_request", "data_subject_request", String(requestRow.id), null, JSON.stringify(requestRow), clientIp(req));
    res.json({ ok: true, data: { request: requestRow } });
  } catch (err) {
    logError("[admin] POST /data-subject-requests error:", err);
    res.status(500).json({ ok: false, error: "Failed to create data subject request" });
  }
});

// ---------------------------------------------------------------------------
// 40. PATCH /admin/data-subject-requests/:id — update request status
// ---------------------------------------------------------------------------
adminRouter.patch("/data-subject-requests/:id", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "Invalid request id" });

    const { status, exported_artifact_url, notes } = req.body ?? {};
    const sets: string[] = [];
    const vals: any[] = [];
    let p = 1;

    if (status !== undefined) {
      if (!["requested", "in_progress", "fulfilled", "rejected"].includes(status)) {
        return res.status(400).json({ ok: false, error: "Invalid status" });
      }
      sets.push(`status = $${p++}`); vals.push(status);
      if (status === "fulfilled") sets.push(`fulfilled_at = COALESCE(fulfilled_at, NOW())`);
    }
    if (exported_artifact_url !== undefined) { sets.push(`exported_artifact_url = $${p++}`); vals.push(exported_artifact_url); }
    if (notes !== undefined) { sets.push(`notes = $${p++}`); vals.push(notes); }
    if (!sets.length) return res.status(400).json({ ok: false, error: "No valid fields to update" });

    sets.push(`handled_by_admin_id = $${p++}`); vals.push(req.admin!.id);
    sets.push(`updated_at = NOW()`);
    vals.push(id);

    const { rows } = await pgPool.query(
      `UPDATE data_subject_request SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Data subject request not found" });
    const requestRow = rows[0];
    await logAdminAction(req.admin!.id, "update_data_subject_request", "data_subject_request", String(id), null, JSON.stringify(requestRow), clientIp(req));
    res.json({ ok: true, data: { request: requestRow } });
  } catch (err) {
    logError("[admin] PATCH /data-subject-requests/:id error:", err);
    res.status(500).json({ ok: false, error: "Failed to update data subject request" });
  }
});
