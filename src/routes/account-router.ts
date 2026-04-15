// 📂 src/routes/account-router.ts
// 🧭 YUA Settings v2 — Account tab (session management)
//
// Endpoints:
//   GET    /api/account/sessions                  — list active sessions for req.user
//   DELETE /api/account/sessions/:id              — revoke a single session (ownership-checked)
//   POST   /api/account/sessions/logout-all       — revoke every session except the current one
//
// Wiring note (for Agent D):
//   Add to `yua-backend/src/routes/index.ts` after other authed routers:
//
//     import accountRouter from "./account-router";
//     app.use("/api/account", requireAuth, accountRouter);
//
//   (The `requireAuth` middleware also populates `req.sessionId`, which this
//   router relies on for "logout all except current" and "isCurrent" marking.)

import { Router, type Request, type Response } from "express";
import { pgPool } from "../db/postgres";
import {
  listSessions,
  revokeSession,
  revokeAllExcept,
} from "../auth/session-registry";

const router = Router();

/* ======================================================
   GET /api/account/sessions
====================================================== */
router.get("/sessions", async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const currentSessionId: string | null =
      (req as any).sessionId ?? null;
    const sessions = await listSessions(Number(userId), currentSessionId);
    return res.json({ sessions });
  } catch (err) {
    console.error("[account-router] GET /sessions failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/* ======================================================
   DELETE /api/account/sessions/:id
   - Ownership check: the session row's user_id must match req.user.userId
====================================================== */
router.delete("/sessions/:id", async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const targetId = String(req.params.id || "").trim();
    if (!targetId) {
      return res.status(400).json({ error: "missing session id" });
    }

    // Ownership check — prevent users from revoking other users' sessions.
    const { rows } = await pgPool.query<{ user_id: string | number }>(
      `SELECT user_id FROM user_sessions WHERE session_id = $1 LIMIT 1`,
      [targetId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "session not found" });
    }
    if (Number(rows[0].user_id) !== Number(userId)) {
      return res.status(403).json({ error: "forbidden" });
    }

    await revokeSession(targetId);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[account-router] DELETE /sessions/:id failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

/* ======================================================
   POST /api/account/sessions/logout-all
   - Revokes every active session for req.user except the current one.
====================================================== */
router.post("/sessions/logout-all", async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const currentSessionId: string = (req as any).sessionId ?? "";
    if (!currentSessionId) {
      // Without a current session id we'd accidentally log the caller out too.
      // Refuse explicitly so the client can surface a clear error.
      return res
        .status(400)
        .json({ error: "no current session (cannot determine which to keep)" });
    }
    const revoked = await revokeAllExcept(Number(userId), currentSessionId);
    return res.json({ revoked });
  } catch (err) {
    console.error("[account-router] POST /sessions/logout-all failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
