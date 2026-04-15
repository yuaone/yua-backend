// src/routes/artifact-router.ts
// REST API for fetching stored artifacts from the database.
// Mount: /api/artifacts (requireFirebaseAuth)

import { Router, type Request, type Response } from "express";
import { pgPool } from "../db/postgres";

const router = Router();

function getUserId(req: Request): number | null {
  const raw = (req as any).user?.userId ?? (req as any).user?.id;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* GET /api/artifacts/:id — fetch single artifact by id */
router.get("/:id", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "ID_REQUIRED" });

  try {
    const { rows } = await pgPool.query(
      `SELECT id, user_id, thread_id, kind, title, mime, content,
              blob_path, size_bytes, status, created_at, completed_at, expires_at
       FROM artifacts WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const row = rows[0];
    return res.json({
      ok: true,
      artifact: {
        id: row.id,
        userId: row.user_id,
        threadId: row.thread_id,
        kind: row.kind,
        title: row.title,
        mime: row.mime,
        content: row.content,
        blobPath: row.blob_path,
        sizeBytes: row.size_bytes,
        status: row.status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        expiresAt: row.expires_at,
      },
    });
  } catch (err: any) {
    console.error("[artifact-router] GET /:id failed", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* GET /api/artifacts?threadId=N — list artifacts for a thread */
router.get("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

  const threadId = Number(req.query.threadId);
  if (!Number.isFinite(threadId)) {
    return res.status(400).json({ ok: false, error: "THREAD_ID_REQUIRED" });
  }

  try {
    const { rows } = await pgPool.query(
      `SELECT id, kind, title, mime, size_bytes, status, created_at, completed_at
       FROM artifacts WHERE user_id = $1 AND thread_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [userId, threadId],
    );

    return res.json({
      ok: true,
      artifacts: rows.map((r: any) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        mime: r.mime,
        sizeBytes: r.size_bytes,
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      })),
      total: rows.length,
    });
  } catch (err: any) {
    console.error("[artifact-router] GET / failed", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

export default router;
