// src/skills/skill-retrieval.ts
//
// Phase 2 W7 — Skill retrieval via pgvector.
//
// Given a user query, embed it and return the top-k skill slugs whose
// compact form is closest in cosine distance. Prompt-runtime uses the
// top-k set to prioritize which skills get expanded to full body in
// the <skills> block (the two-pass renderer's Pass 2 expands from
// front-of-list first).
//
// Embeddings are cached in `skill_embeddings` (pgvector hnsw index):
//   (scope, skill_id, user_id, mode) → vector(1536)
//
// user_id=0 is the "shared" slot for built-in skills (everyone sees
// the same embedding). user_id>0 is for user-authored skills.
//
// Cost: text-embedding-3-small is $0.02/1M tokens. A full backfill of
// 28 built-in compact entries (~150 tokens each) costs $0.000084. A
// per-turn query embedding is one call at ~50 tokens = $0.000001.
// Both are within noise of any chat turn cost.

import crypto from "node:crypto";
import { pgPool } from "../db/postgres";
import { BUILTIN_SKILLS } from "./builtin-skills";
import type { Skill } from "./skills-registry";

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIM = 1536;
const BACKFILL_USER_ID = 0; // shared slot for built-ins
const BACKFILL_LOCK_KEY = "skills:backfill";

let backfillPromise: Promise<void> | null = null;
let backfillDone = false;

/**
 * Call OpenAI embedding API. Returns a 1536-dim vector as number[].
 * Fails silently on any error and returns null — caller falls back to
 * no-retrieval, deterministic render order.
 */
async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const trimmed = (text || "").slice(0, 8_000).trim();
  if (!trimmed) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: trimmed,
      }),
    });
    if (!res.ok) {
      console.warn("[skill-retrieval] embed api non-ok", res.status);
      return null;
    }
    const json: any = await res.json();
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
      console.warn("[skill-retrieval] embed api bad shape", {
        len: Array.isArray(vec) ? vec.length : "not-array",
      });
      return null;
    }
    return vec as number[];
  } catch (err) {
    console.warn("[skill-retrieval] embedText failed", err);
    return null;
  }
}

/**
 * Convert a number[] to the pgvector literal string format: "[1.23,4.56,...]"
 */
function toPgVector(vec: number[]): string {
  return "[" + vec.join(",") + "]";
}

/**
 * Build the compact text we embed. We use name + description + "When
 * to use" so the query-to-skill match fires on intent, not on body
 * examples. The hash is the same deterministic fingerprint so we
 * skip re-embedding if nothing changed.
 */
function buildEmbedText(skill: Skill): string {
  const parts: string[] = [];
  parts.push(skill.name);
  parts.push(skill.description);
  const md = skill.markdown || "";
  const when = /##\s+When to use[\s\S]*?(?=\n##\s|$)/i.exec(md)?.[0];
  if (when) parts.push(when);
  return parts.join("\n\n").slice(0, 4_000);
}

function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Idempotent backfill: embed every built-in skill's compact form and
 * upsert into skill_embeddings. Skips skills whose content_hash
 * already matches (content unchanged since last embed).
 *
 * Runs at most once per process (backfillPromise memoization). First
 * chat turn after restart triggers the backfill; subsequent turns
 * return immediately.
 */
export function ensureSkillEmbeddingsBackfilled(): Promise<void> {
  if (backfillDone) return Promise.resolve();
  if (backfillPromise) return backfillPromise;
  backfillPromise = (async () => {
    try {
      // Advisory lock so concurrent engine processes don't all embed
      // the same rows. Non-blocking: if we can't get the lock, another
      // process is doing it, we just wait for it.
      const lockId = parseInt(
        crypto.createHash("sha1").update(BACKFILL_LOCK_KEY).digest("hex").slice(0, 8),
        16,
      );
      const lockR = await pgPool.query<{ got: boolean }>(
        `SELECT pg_try_advisory_lock($1) AS got`,
        [lockId],
      );
      if (!lockR.rows[0]?.got) {
        console.log("[skill-retrieval] backfill lock held by peer, skipping");
        return;
      }
      try {
        let embedded = 0;
        let skipped = 0;
        for (const skill of BUILTIN_SKILLS) {
          const text = buildEmbedText(skill);
          const hash = hashContent(text);

          // Check if row exists with same hash
          const existing = await pgPool.query<{ content_hash: string }>(
            `SELECT content_hash FROM skill_embeddings
               WHERE scope = 'official' AND skill_id = $1
                 AND user_id = $2 AND mode = 'compact'
               LIMIT 1`,
            [skill.id, BACKFILL_USER_ID],
          );
          if (existing.rows[0]?.content_hash === hash) {
            skipped++;
            continue;
          }

          const vec = await embedText(text);
          if (!vec) {
            console.warn(
              "[skill-retrieval] embed returned null for",
              skill.id,
            );
            continue;
          }

          await pgPool.query(
            `INSERT INTO skill_embeddings
               (scope, skill_id, user_id, mode, content_hash, embedding, updated_at)
               VALUES ('official', $1, $2, 'compact', $3, $4::vector, NOW())
               ON CONFLICT (scope, skill_id, user_id, mode) DO UPDATE
                 SET content_hash = EXCLUDED.content_hash,
                     embedding = EXCLUDED.embedding,
                     updated_at = NOW()`,
            [skill.id, BACKFILL_USER_ID, hash, toPgVector(vec)],
          );
          embedded++;
        }
        console.log("[skill-retrieval] backfill complete", {
          embedded,
          skipped,
          total: BUILTIN_SKILLS.length,
        });
        backfillDone = true;
      } finally {
        await pgPool
          .query(`SELECT pg_advisory_unlock($1)`, [lockId])
          .catch(() => {});
      }
    } catch (err) {
      console.warn("[skill-retrieval] backfill failed", err);
      // Reset the memoized promise so the next turn can retry.
      backfillPromise = null;
    }
  })();
  return backfillPromise;
}

/**
 * Given the user's current message, return the slugs of the top-k
 * skills whose compact embedding is closest. Returns an empty array
 * if embeddings are unavailable (no API key, backfill not done,
 * query embed failed).
 *
 * The caller uses this to reorder the enabled skill list: top-k slugs
 * move to the front so the renderer expands them to full body first.
 */
export async function retrieveTopSkills(
  query: string,
  k = 5,
): Promise<string[]> {
  const trimmed = (query || "").trim();
  if (trimmed.length < 4) return [];
  if (!process.env.OPENAI_API_KEY) return [];

  // Fire-and-forget backfill trigger. Don't await — first turn takes
  // the embedding hit either way.
  void ensureSkillEmbeddingsBackfilled();

  const vec = await embedText(trimmed);
  if (!vec) return [];

  try {
    const r = await pgPool.query<{ skill_id: string }>(
      `SELECT skill_id
         FROM skill_embeddings
         WHERE scope = 'official'
           AND user_id = $1
           AND mode = 'compact'
         ORDER BY embedding <=> $2::vector
         LIMIT $3`,
      [BACKFILL_USER_ID, toPgVector(vec), k],
    );
    // Convert builtin.<slug> id to slug by matching against the catalog.
    const idToSlug = new Map(BUILTIN_SKILLS.map((s) => [s.id, s.slug]));
    const slugs = r.rows
      .map((row) => idToSlug.get(row.skill_id))
      .filter((s): s is string => !!s);
    console.log("[skill-retrieval] top-k", { k, slugs });
    return slugs;
  } catch (err) {
    console.warn("[skill-retrieval] cosine query failed", err);
    return [];
  }
}
