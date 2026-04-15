// yua-backend/src/routes/search-router.ts
// GET /api/search — chat thread search

import { Router, type Request, type Response } from "express";
import { searchThreads, getRecentThreads } from "../db/search-queries.js";
import { redisPub } from "../db/redis.js";
import crypto from "crypto";

const router = Router();

interface SearchResponseBody {
  ok: true;
  results: Array<{
    threadId: number;
    title: string;
    snippet: string | null;
    lastActivityAt: string;
    score: number;
  }>;
  method: "keyword" | "recent";
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const wsId = req.workspace?.id;
    const userId = req.user?.userId;
    if (!wsId || !userId) return res.status(400).json({ ok: false, error: "workspace/user required" });

    const query = req.query.q ? String(req.query.q).trim() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    // Empty query → recent threads
    if (!query) {
      const cacheKey = `search:ws:${wsId}:recent`;
      try {
        const cached = await redisPub.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));
      } catch {}

      const rows = await getRecentThreads({ workspaceId: wsId, userId, limit });
      const response: SearchResponseBody = {
        ok: true,
        results: rows.map((r) => ({
          threadId: r.thread_id,
          title: r.title,
          snippet: r.snippet,
          lastActivityAt: new Date(r.last_activity_at).toISOString(),
          score: r.score,
        })),
        method: "recent",
      };

      try { await redisPub.set(cacheKey, JSON.stringify(response), "EX", 60); } catch {}
      return res.json(response);
    }

    // Keyword search
    const queryHash = crypto.createHash("md5").update(query).digest("hex").slice(0, 12);
    const cacheKey = `search:ws:${wsId}:q:${queryHash}`;
    try {
      const cached = await redisPub.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    } catch {}

    const rows = await searchThreads({ workspaceId: wsId, userId, query, limit });

    const response: SearchResponseBody = {
      ok: true,
      results: rows.map((r) => ({
        threadId: r.thread_id,
        title: r.title,
        snippet: r.snippet,
        lastActivityAt: new Date(r.last_activity_at).toISOString(),
        score: r.score,
      })),
      method: "keyword",
    };

    try { await redisPub.set(cacheKey, JSON.stringify(response), "EX", 15); } catch {}
    return res.json(response);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    console.error("[SEARCH]", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
