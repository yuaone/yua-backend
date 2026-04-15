// yua-backend/src/routes/library-router.ts
// REST API for the Library page.
// Middleware chain: requireFirebaseAuth → withWorkspace → this router

import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";
import crypto from "crypto";
import {
  type LibraryTab,
  type LibraryListResponse,
  type LibraryCountsResponse,
  categorizeAsset,
  parseAssetKey,
  buildAssetKey,
} from "yua-shared/library/library-types";
import {
  listAssets,
  countAssets,
  getAssetById,
  softDeleteUpload,
  insertDirectUpload,
} from "../db/library-queries.js";
import { pgPool } from "../db/postgres.js";
import { redisPub } from "../db/redis.js";

const router = Router();

/* ── Upload config ───────────────────────────────── */

const UPLOAD_BASE = "/mnt/yua/assets/library";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const diskStorage = multer.diskStorage({
  destination: (_req: Request, _file, cb) => {
    const wsId = _req.workspace?.id ?? "default";
    const userId = _req.user?.userId ?? 0;
    const dir = path.join(UPLOAD_BASE, wsId, String(userId));
    fs.mkdir(dir, { recursive: true })
      .then(() => cb(null, dir))
      .catch(() => cb(null, dir));
  },
  filename: (_req, file, cb) => {
    const uuid = crypto.randomUUID();
    const ext = path.extname(file.originalname) || "";
    cb(null, `${uuid}${ext}`);
  },
});

const upload = multer({ limits: { fileSize: MAX_FILE_SIZE }, storage: diskStorage });

/* ── Helpers ─────────────────────────────────────── */

async function invalidateCache(wsId: string): Promise<void> {
  try {
    const keys = await redisPub.keys(`lib:ws:${wsId}:*`);
    if (keys.length > 0) await redisPub.del(...keys);
  } catch { /* non-fatal */ }
}

/** Strip file:// protocol from blob_path (doc_image URIs use file:///mnt/...) */
function resolveFilePath(blobPath: string): string {
  if (blobPath.startsWith("file://")) return blobPath.slice(7);
  return blobPath;
}

const VALID_TABS = new Set<string>(["all", "artifact", "image", "file"]);

/* ══════════════════════════════════════════════════
   GET /api/library — paginated asset list
══════════════════════════════════════════════════ */
router.get("/", async (req: Request, res: Response) => {
  try {
    const wsId = req.workspace?.id;
    if (!wsId) return res.status(400).json({ ok: false, error: "workspace required" });

    const rawTab = String(req.query.tab ?? "all");
    const tab: LibraryTab = VALID_TABS.has(rawTab) ? (rawTab as LibraryTab) : "all";
    const query = req.query.q ? String(req.query.q).trim() : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

    // Parse cursor: "ts|source|id"
    let cursorTs: string | undefined;
    let cursorSource: string | undefined;
    let cursorId: string | undefined;
    if (req.query.cursor) {
      const parts = String(req.query.cursor).split("|");
      if (parts.length === 3) {
        cursorTs = parts[0];
        cursorSource = parts[1];
        cursorId = parts[2];
      }
    }

    // Redis page cache
    const cacheKey = `lib:ws:${wsId}:${tab}:${query ?? ""}:${req.query.cursor ?? "first"}`;
    try {
      const cached = await redisPub.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    } catch { /* cache miss is fine */ }

    // Fetch limit+1 for hasMore detection
    const rows = await listAssets({
      workspaceId: wsId,
      tab,
      query,
      cursorTs,
      cursorSource,
      cursorId,
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const assets = items.map((r) => ({
      id: buildAssetKey(r.source, r.asset_id),
      source: r.source,
      name: r.name,
      mime: r.mime,
      ext: r.ext,
      category: categorizeAsset(r.mime, r.ext, r.artifact_kind),
      sizeBytes: Number(r.size_bytes),
      artifactKind: r.artifact_kind,
      hasInlineContent: r.has_inline_content,
      thumbnailUrl: r.mime.startsWith("image/") && r.blob_path
        ? `/api/library/asset/${buildAssetKey(r.source, r.asset_id)}/content`
        : null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));

    const lastItem = items[items.length - 1];
    const nextCursor =
      hasMore && lastItem
        ? `${new Date(lastItem.created_at).toISOString()}|${lastItem.source}|${lastItem.asset_id}`
        : null;

    const counts = await countAssets(wsId);

    const response: LibraryListResponse = { ok: true, assets, nextCursor, counts };

    // Cache 30s
    try {
      await redisPub.set(cacheKey, JSON.stringify(response), "EX", 30);
    } catch { /* non-fatal */ }

    return res.json(response);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[LIBRARY][LIST]", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* ══════════════════════════════════════════════════
   GET /api/library/counts — tab counts
══════════════════════════════════════════════════ */
router.get("/counts", async (req: Request, res: Response) => {
  try {
    const wsId = req.workspace?.id;
    if (!wsId) return res.status(400).json({ ok: false });
    const counts = await countAssets(wsId);
    const response: LibraryCountsResponse = { ok: true, counts };
    return res.json(response);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* ══════════════════════════════════════════════════
   GET /api/library/asset/:key/content — serve file
══════════════════════════════════════════════════ */
router.get("/asset/:key/content", async (req: Request, res: Response) => {
  try {
    const wsId = req.workspace?.id;
    const parsed = parseAssetKey(req.params.key);
    if (!parsed || !wsId) return res.status(400).json({ ok: false });

    const row = await getAssetById(parsed.source, parsed.id, wsId);
    if (!row) return res.status(404).json({ ok: false, error: "not found" });

    // Inline content (artifacts with text body)
    if (row.has_inline_content && row.source === "artifact") {
      const artResult = await pgPool.query<{ content: string | null; mime: string }>(
        "SELECT content, mime FROM artifacts WHERE id = $1",
        [parsed.id],
      );
      const art = artResult.rows[0];
      if (!art?.content) return res.status(404).json({ ok: false });
      res.setHeader("Content-Type", art.mime || "text/plain; charset=utf-8");
      return res.send(art.content);
    }

    // File on disk
    if (row.blob_path) {
      const diskPath = resolveFilePath(row.blob_path);
      try {
        await fs.access(diskPath);
      } catch {
        return res.status(404).json({ ok: false, error: "file not found on disk" });
      }
      res.setHeader("Content-Type", row.mime || "application/octet-stream");
      return createReadStream(diskPath).pipe(res);
    }

    return res.status(404).json({ ok: false, error: "no content available" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* ══════════════════════════════════════════════════
   GET /api/library/asset/:key/download
══════════════════════════════════════════════════ */
router.get("/asset/:key/download", async (req: Request, res: Response) => {
  try {
    const wsId = req.workspace?.id;
    const parsed = parseAssetKey(req.params.key);
    if (!parsed || !wsId) return res.status(400).json({ ok: false });

    const row = await getAssetById(parsed.source, parsed.id, wsId);
    if (!row) return res.status(404).json({ ok: false });

    const safeName = encodeURIComponent(row.name).replace(/%20/g, "+");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Type", row.mime || "application/octet-stream");

    if (row.has_inline_content && row.source === "artifact") {
      const artResult = await pgPool.query<{ content: string | null }>(
        "SELECT content FROM artifacts WHERE id = $1",
        [parsed.id],
      );
      return res.send(artResult.rows[0]?.content ?? "");
    }

    if (row.blob_path) {
      try {
        await fs.access(row.blob_path);
      } catch {
        return res.status(404).json({ ok: false });
      }
      return createReadStream(row.blob_path).pipe(res);
    }

    return res.status(404).json({ ok: false });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* ══════════════════════════════════════════════════
   POST /api/library/upload — direct file upload
══════════════════════════════════════════════════ */
router.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const wsId = req.workspace?.id;
    const userId = req.user?.userId;
    const file = req.file;
    if (!wsId || !userId || !file) {
      return res.status(400).json({ ok: false, error: "missing workspace, user, or file" });
    }

    const ext = path.extname(file.originalname).replace(".", "").toLowerCase();

    const id = await insertDirectUpload({
      userId,
      workspaceId: wsId,
      fileName: file.originalname,
      mimeType: file.mimetype,
      ext,
      sizeBytes: file.size,
      filePath: file.path,
    });

    await invalidateCache(wsId);

    const asset = {
      id: buildAssetKey("direct_upload", id),
      source: "direct_upload" as const,
      name: file.originalname,
      mime: file.mimetype,
      ext,
      category: categorizeAsset(file.mimetype, ext),
      sizeBytes: file.size,
      artifactKind: null,
      hasInlineContent: false,
      thumbnailUrl: file.mimetype.startsWith("image/")
        ? `/api/library/asset/direct_upload:${id}/content`
        : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return res.json({ ok: true, asset });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[LIBRARY][UPLOAD]", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* ══════════════════════════════════════════════════
   DELETE /api/library/asset/:key — soft delete
══════════════════════════════════════════════════ */
router.delete("/asset/:key", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const wsId = req.workspace?.id;
    const parsed = parseAssetKey(req.params.key);
    if (!parsed || !userId || !wsId) return res.status(400).json({ ok: false });

    if (parsed.source === "direct_upload") {
      const ok = await softDeleteUpload(parsed.id, userId);
      if (!ok) return res.status(404).json({ ok: false });
    } else if (parsed.source === "artifact") {
      const r = await pgPool.query(
        "UPDATE artifacts SET status = 'expired' WHERE id = $1 AND user_id = $2",
        [parsed.id, userId],
      );
      if ((r.rowCount ?? 0) === 0) return res.status(404).json({ ok: false });
    } else {
      return res.status(400).json({ ok: false, error: "cannot delete this source type" });
    }

    await invalidateCache(wsId);
    return res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
