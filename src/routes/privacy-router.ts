// 📂 src/routes/privacy-router.ts
// Settings v2 — Privacy tab.
//
//   POST /api/privacy/export                        → create a new export request
//   POST /api/privacy/delete-request                → record a delete request (log-only)
//   GET  /api/privacy/export/status/:id             → poll status (pending|processing|ready|…)
//   GET  /api/privacy/export/download/:id           → JWT-gated file stream (Phase F.5)
//
// Security — download:
//   - JWT is mandatory (req.user.id).
//   - SELECT enforces `user_id = req.user.id` → leaking the numeric
//     id does NOT leak the file.
//   - Atomic UPDATE with CHECK on status/expiry/download_count so a
//     race between two clicks can't over-count downloads.
import fs from "node:fs";
import path from "node:path";
import { Router, Request, Response } from "express";
import { requireFirebaseAuth } from "../auth/auth.express";
import { withWorkspace } from "../middleware/with-workspace";
import { rateLimit } from "../middleware/rate-limit";
import { pgPool } from "../db/postgres";

const router = Router();

// Security note: even though every request is auth-gated, these endpoints
// insert ledger rows and are therefore a cheap DoS vector for a compromised
// account. The shared rate-limit middleware caps burst + enforces a 1-minute
// ban after repeated abuse — sufficient for "log-only intent" endpoints.
router.use(rateLimit);
router.use(requireFirebaseAuth);
router.use(withWorkspace);

router.post("/export", async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    const r = await pgPool.query<{ requested_at: string }>(
      `INSERT INTO data_export_requests (user_id)
       VALUES ($1)
       RETURNING requested_at`,
      [userId]
    );
    return res.json({
      ok: true,
      requestedAt: r.rows[0]?.requested_at ?? new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("❌ POST /privacy/export error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "privacy_export_failed" });
  }
});

/* ------------------------------------------------------------------
 * GET /api/privacy/export/status/:id
 *
 * Poll the fulfillment state of a single export request. Used by the
 * Privacy page when the user lands via `?exportReady={id}` — the page
 * hits this to confirm the row is still `ready` before showing the
 * download button. Ownership-gated by user_id.
 * ------------------------------------------------------------------ */
router.get("/export/status/:id", async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const requestId = Number(req.params.id);
  if (!Number.isFinite(requestId) || requestId <= 0) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  try {
    const { rows } = await pgPool.query(
      `SELECT id, status, file_size_bytes, expires_at,
              download_count, download_limit, requested_at, completed_at,
              error_message
       FROM data_export_requests
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [requestId, userId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }
    const row = rows[0];
    return res.json({
      ok: true,
      id: row.id,
      status: row.status,
      fileSizeBytes: row.file_size_bytes ? Number(row.file_size_bytes) : null,
      expiresAt: row.expires_at,
      downloadsRemaining: Math.max(
        0,
        Number(row.download_limit) - Number(row.download_count),
      ),
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
    });
  } catch (err: any) {
    console.error("❌ GET /privacy/export/status failed:", err);
    return res.status(500).json({ ok: false, error: "status_query_failed" });
  }
});

/* ------------------------------------------------------------------
 * GET /api/privacy/export/download/:id
 *
 * Stream the prepared ZIP to the caller. The JWT-gated magic link in
 * the user's email ultimately triggers this after /settings/privacy
 * re-authenticates them and fires an authFetch.
 *
 * Steps:
 *   1. requireFirebaseAuth → req.user.id
 *   2. Atomic UPDATE that:
 *        - matches the row by (id, user_id)
 *        - requires status='ready'
 *        - requires expires_at > NOW()
 *        - requires download_count < download_limit
 *        - increments download_count
 *      RETURNING the file_path. If zero rows updated, respond 404/410.
 *   3. Stream the file from disk with Content-Disposition + Content-Length.
 *   4. If the increment maxed out downloads, follow up with an async
 *      UPDATE status='consumed' (best-effort).
 * ------------------------------------------------------------------ */
router.get("/export/download/:id", async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const requestId = Number(req.params.id);
  if (!Number.isFinite(requestId) || requestId <= 0) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }

  try {
    // Atomic claim — only one of two concurrent clicks can win.
    const claim = await pgPool.query<{
      file_path: string;
      file_size_bytes: string;
      download_count: number;
      download_limit: number;
    }>(
      `UPDATE data_export_requests
       SET download_count = download_count + 1
       WHERE id = $1
         AND user_id = $2
         AND status = 'ready'
         AND expires_at IS NOT NULL
         AND expires_at > NOW()
         AND download_count < download_limit
         AND file_path IS NOT NULL
       RETURNING file_path, file_size_bytes, download_count, download_limit`,
      [requestId, userId],
    );

    if (claim.rows.length === 0) {
      // Differentiate 404 vs 410 for better client UX.
      const { rows } = await pgPool.query(
        `SELECT status, expires_at, download_count, download_limit
         FROM data_export_requests
         WHERE id = $1 AND user_id = $2`,
        [requestId, userId],
      );
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      const row = rows[0];
      if (row.status !== "ready") {
        return res.status(409).json({
          ok: false,
          error: "not_ready",
          status: row.status,
        });
      }
      if (row.expires_at && new Date(row.expires_at) <= new Date()) {
        return res.status(410).json({ ok: false, error: "expired" });
      }
      if (Number(row.download_count) >= Number(row.download_limit)) {
        return res.status(410).json({ ok: false, error: "limit_reached" });
      }
      return res.status(500).json({ ok: false, error: "unknown_claim_failure" });
    }

    const { file_path, file_size_bytes, download_count, download_limit } =
      claim.rows[0];

    // Sanity: file must still exist on disk.
    try {
      await fs.promises.access(file_path, fs.constants.R_OK);
    } catch {
      await pgPool
        .query(
          `UPDATE data_export_requests
           SET status='failed',
               error_message='file missing at download time'
           WHERE id = $1`,
          [requestId],
        )
        .catch(() => {});
      return res.status(410).json({ ok: false, error: "file_missing" });
    }

    // If this download maxes out the counter, flip status to consumed.
    if (download_count >= download_limit) {
      pgPool
        .query(
          `UPDATE data_export_requests SET status='consumed' WHERE id = $1`,
          [requestId],
        )
        .catch(() => {});
    }

    const fileName = `yua-export-${requestId}.zip`;
    const sizeBytes = Number(file_size_bytes ?? 0);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`,
    );
    if (sizeBytes > 0) {
      res.setHeader("Content-Length", String(sizeBytes));
    }
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(file_path);
    stream.on("error", (err) => {
      console.error("❌ export download stream failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "stream_failed" });
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  } catch (err: any) {
    console.error("❌ GET /privacy/export/download failed:", err);
    return res.status(500).json({ ok: false, error: "download_failed" });
  }
});

router.post("/delete-request", async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    const r = await pgPool.query<{ requested_at: string }>(
      `INSERT INTO data_delete_requests (user_id)
       VALUES ($1)
       RETURNING requested_at`,
      [userId]
    );
    return res.json({
      ok: true,
      requestedAt: r.rows[0]?.requested_at ?? new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("❌ POST /privacy/delete-request error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "privacy_delete_request_failed" });
  }
});

export default router;
