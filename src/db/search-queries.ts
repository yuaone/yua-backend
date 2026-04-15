// yua-backend/src/db/search-queries.ts
// DB query functions for chat search.
// Uses pg_trgm GIN indexes for fast ILIKE on title + content.

import { pgPool } from "./postgres.js";

export interface SearchResultRow {
  thread_id: number;
  title: string;
  snippet: string | null;
  last_activity_at: string;
  score: number;
}

/**
 * Search threads by title + message content.
 * Returns deduplicated results ordered by last activity.
 */
export async function searchThreads(params: {
  workspaceId: string;
  userId: number;
  query: string;
  limit: number;
}): Promise<SearchResultRow[]> {
  const { workspaceId, userId, query, limit } = params;

  const sql = `
    WITH title_matches AS (
      SELECT
        ct.id AS thread_id,
        ct.title,
        NULL::text AS snippet,
        ct.last_activity_at,
        1.0::float AS score
      FROM conversation_threads ct
      WHERE ct.workspace_id = $1
        AND ct.user_id = $3
        AND ct.title ILIKE '%' || $2 || '%'
      ORDER BY ct.last_activity_at DESC
      LIMIT $4
    ),
    content_matches AS (
      SELECT DISTINCT ON (ct.id)
        ct.id AS thread_id,
        ct.title,
        SUBSTRING(
          cm.content
          FROM GREATEST(1, POSITION(LOWER($2) IN LOWER(cm.content)) - 40)
          FOR 120
        ) AS snippet,
        ct.last_activity_at,
        0.8::float AS score
      FROM chat_messages cm
      JOIN conversation_threads ct ON ct.id = cm.thread_id
      WHERE ct.workspace_id = $1
        AND ct.user_id = $3
        AND cm.content ILIKE '%' || $2 || '%'
      ORDER BY ct.id, cm.created_at DESC
    ),
    combined AS (
      SELECT * FROM title_matches
      UNION ALL
      SELECT * FROM content_matches
    ),
    deduped AS (
      SELECT DISTINCT ON (thread_id)
        thread_id, title, snippet, last_activity_at,
        MAX(score) OVER (PARTITION BY thread_id) AS score
      FROM combined
      ORDER BY thread_id, score DESC
    )
    SELECT * FROM deduped
    ORDER BY last_activity_at DESC
    LIMIT $4
  `;

  const r = await pgPool.query<SearchResultRow>(sql, [workspaceId, query, userId, limit]);
  return r.rows;
}

/**
 * Get recent threads (when search is empty).
 */
export async function getRecentThreads(params: {
  workspaceId: string;
  userId: number;
  limit: number;
}): Promise<SearchResultRow[]> {
  const { workspaceId, userId, limit } = params;

  const sql = `
    SELECT
      ct.id AS thread_id,
      ct.title,
      NULL::text AS snippet,
      ct.last_activity_at,
      1.0::float AS score
    FROM conversation_threads ct
    WHERE ct.workspace_id = $1
      AND ct.user_id = $2
      AND ct.title IS NOT NULL
      AND ct.title != ''
    ORDER BY ct.last_activity_at DESC
    LIMIT $3
  `;

  const r = await pgPool.query<SearchResultRow>(sql, [workspaceId, userId, limit]);
  return r.rows;
}
