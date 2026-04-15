// src/routes/memory-md-router.ts
//
// Phase D.6 — User Memory (Markdown SSOT).
//
// The old /settings/memory was a CRUD list of structured rows. Research
// showed that models parse structured context better when it's presented
// as a single Markdown document than as a list of records — there's
// context around each fact, not just the fact itself. This router
// exposes one Markdown document per user:
//
//   GET  /api/me/memory-md   → { ok, markdown, updatedAt }
//   PUT  /api/me/memory-md   → { ok, markdown, updatedAt }
//
// Persisted to `user_memory_md(user_id, markdown, updated_at)`.
// 64KB hard cap.

import { Router, type Request, type Response } from "express";
import { pgPool } from "../db/postgres";
import { appendToSection, parseAiExport } from "./memory-md-helpers";

const router = Router();
const MEMORY_MD_CAP = 64 * 1024;

function getUserId(req: Request): number | null {
  const raw = (req as any).user?.userId ?? (req as any).user?.id;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

router.get("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const r = await pgPool.query<{ markdown: string; updated_at: Date }>(
      `SELECT markdown, updated_at FROM user_memory_md WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    const row = r.rows[0];
    return res.json({
      ok: true,
      markdown: row?.markdown ?? "",
      updatedAt: row?.updated_at ?? null,
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

/**
 * POST /api/me/memory-md/append
 *
 * Append a fact to a specific Markdown section. Idempotent: if a line
 * matching the new content already exists in that section, the request
 * is a no-op. If the section doesn't exist yet, it's created at the
 * bottom of the document.
 *
 * Body: { section: string, content: string }
 *
 * This is the write path that the `memory_append` tool call will route
 * through once the execution-engine tool dispatcher is wired up. For
 * now, the endpoint is reachable directly for frontend automation and
 * manual curl tests.
 */
router.post("/append", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const sectionRaw = typeof req.body?.section === "string" ? req.body.section : "";
  const contentRaw = typeof req.body?.content === "string" ? req.body.content : "";
  const section = sectionRaw.trim().slice(0, 120);
  const content = contentRaw.trim().slice(0, 2_000);
  if (!section || !content) {
    return res.status(400).json({ ok: false, error: "section_and_content_required" });
  }

  // Sanitize the same way PUT does.
  const cleanContent = content
    .replace(/<\/user_memories>/gi, "")
    .replace(/<\/memory>/gi, "");

  try {
    const prev = await pgPool.query<{ markdown: string }>(
      `SELECT markdown FROM user_memory_md WHERE user_id = $1`,
      [userId],
    );
    const existing = prev.rows[0]?.markdown ?? "";

    const merged = appendToSection(existing, section, cleanContent);
    if (merged === existing) {
      // Duplicate or no-op — return current state without writing.
      return res.json({ ok: true, markdown: existing, dedup: true });
    }
    if (merged.length > MEMORY_MD_CAP) {
      return res.status(413).json({ ok: false, error: "too_large", cap: MEMORY_MD_CAP });
    }

    const r = await pgPool.query<{ updated_at: Date }>(
      `INSERT INTO user_memory_md (user_id, markdown)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET markdown = EXCLUDED.markdown, updated_at = NOW()
         RETURNING updated_at`,
      [userId, merged],
    );
    return res.json({
      ok: true,
      markdown: merged,
      updatedAt: r.rows[0]?.updated_at ?? null,
      dedup: false,
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

/**
 * (appendToSection implementation moved to ./memory-md-helpers.ts so the
 * openai-tool-registry memory_append handler can reuse it without an
 * HTTP round-trip.)
 */

/**
 * POST /api/me/memory-md/import
 *
 * Bulk-import a user's memories from another assistant. Accepts the plain
 * text block produced by the "export my stored memories" prompt, parses
 * it into atomic entries, and runs each entry through appendToSection()
 * exactly like the tool-driven path. One DB read + one DB write overall.
 *
 * Body: { rawText: string }
 * Returns: { ok, markdown, updatedAt, stats: { parsed, added, skipped, unknownCategories } }
 */
router.post("/import", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const raw = typeof req.body?.rawText === "string" ? req.body.rawText : "";
  if (!raw.trim()) {
    return res.status(400).json({ ok: false, error: "empty_input" });
  }
  // Cap on UTF-8 byte length (not JS string length — Korean text
  // expands ~3x under UTF-8, so .length is a bad proxy).
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes > MEMORY_MD_CAP * 2) {
    return res
      .status(413)
      .json({ ok: false, error: "too_large", cap: MEMORY_MD_CAP * 2 });
  }

  const { entries, unknownCategories } = parseAiExport(raw);
  if (entries.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "no_entries_parsed",
      unknownCategories,
    });
  }

  try {
    const prev = await pgPool.query<{
      markdown: string;
      updated_at: Date | null;
    }>(
      `SELECT markdown, updated_at FROM user_memory_md WHERE user_id = $1`,
      [userId],
    );
    const prevMarkdown = prev.rows[0]?.markdown ?? "";
    const prevUpdatedAt = prev.rows[0]?.updated_at ?? null;
    let merged = prevMarkdown;
    let added = 0;
    let skipped = 0;
    let truncated = 0;

    for (const entry of entries) {
      const clean = entry.content
        .replace(/<\/user_memories>/gi, "")
        .replace(/<\/memory>/gi, "");
      const next = appendToSection(merged, entry.section, clean);
      if (next === merged) {
        skipped++;
        continue;
      }
      // Per-entry cap check so we persist as much as fits instead of
      // rejecting a 120KB paste wholesale.
      if (Buffer.byteLength(next, "utf8") > MEMORY_MD_CAP) {
        truncated = entries.length - (added + skipped);
        break;
      }
      merged = next;
      added++;
    }

    // No-op short-circuit: nothing actually changed — don't bump
    // updated_at and don't race-UPSERT.
    if (merged === prevMarkdown) {
      return res.json({
        ok: true,
        markdown: prevMarkdown,
        updatedAt: prevUpdatedAt,
        stats: {
          parsed: entries.length,
          added: 0,
          skipped,
          truncated,
          unknownCategories,
        },
      });
    }

    // Optimistic concurrency: only commit if updated_at hasn't moved
    // since we read it. If it has (another tab imported/edited), return
    // 409 so the UI can refetch and retry.
    let updatedAt: Date | null = null;
    if (prevUpdatedAt == null) {
      // No prior row — plain insert. ON CONFLICT guards against a race
      // where another tab inserted between our SELECT and INSERT.
      const ins = await pgPool.query<{ updated_at: Date }>(
        `INSERT INTO user_memory_md (user_id, markdown)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING
           RETURNING updated_at`,
        [userId, merged],
      );
      if (ins.rows.length === 0) {
        return res
          .status(409)
          .json({ ok: false, error: "conflict_retry" });
      }
      updatedAt = ins.rows[0].updated_at;
    } else {
      const upd = await pgPool.query<{ updated_at: Date }>(
        `UPDATE user_memory_md
           SET markdown = $2, updated_at = NOW()
         WHERE user_id = $1 AND updated_at = $3
         RETURNING updated_at`,
        [userId, merged, prevUpdatedAt],
      );
      if (upd.rows.length === 0) {
        return res
          .status(409)
          .json({ ok: false, error: "conflict_retry" });
      }
      updatedAt = upd.rows[0].updated_at;
    }

    return res.json({
      ok: true,
      markdown: merged,
      updatedAt,
      stats: {
        parsed: entries.length,
        added,
        skipped,
        truncated,
        unknownCategories,
      },
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

router.put("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const raw = typeof req.body?.markdown === "string" ? req.body.markdown : "";
  if (raw.length > MEMORY_MD_CAP) {
    return res.status(413).json({ ok: false, error: "too_large", cap: MEMORY_MD_CAP });
  }
  // Sanitize: strip any closing tag that could escape the eventual
  // `<user_memories>` prompt container.
  const clean = raw.replace(/<\/user_memories>/gi, "").replace(/<\/memory>/gi, "");
  try {
    const r = await pgPool.query<{ updated_at: Date }>(
      `INSERT INTO user_memory_md (user_id, markdown)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET markdown = EXCLUDED.markdown, updated_at = NOW()
         RETURNING updated_at`,
      [userId, clean],
    );
    return res.json({
      ok: true,
      markdown: clean,
      updatedAt: r.rows[0]?.updated_at ?? null,
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ ok: false, error: "internal_error", detail: err?.message });
  }
});

export default router;
