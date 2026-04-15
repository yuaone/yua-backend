// yua-backend/src/db/library-queries.ts
// DB query functions for the Library page.
// All data flows through library_assets_view (PostgreSQL VIEW).

import { pgPool } from "./postgres.js";
import type {
  AssetSource,
  LibraryTab,
  LibraryCounts,
} from "yua-shared/library/library-types";

/* ── Row shape returned by the VIEW ──────────────── */

export interface RawAssetRow {
  source: AssetSource;
  asset_id: string;
  user_id: number;
  workspace_id: string;
  artifact_kind: string | null;
  name: string;
  mime: string;
  ext: string;
  size_bytes: number;
  has_inline_content: boolean;
  blob_path: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/* ── Tab → SQL WHERE fragment ────────────────────── */

function tabFilter(tab: LibraryTab): string {
  switch (tab) {
    case "artifact":
      return "AND source = 'artifact'";
    case "image":
      return "AND mime LIKE 'image/%'";
    case "file":
      return "AND source IN ('upload','direct_upload') AND mime NOT LIKE 'image/%'";
    default:
      return ""; // "all"
  }
}

/* ── List assets (cursor pagination) ─────────────── */

export async function listAssets(params: {
  workspaceId: string;
  tab: LibraryTab;
  query?: string;
  cursorTs?: string;
  cursorSource?: string;
  cursorId?: string;
  limit: number;
}): Promise<RawAssetRow[]> {
  const { workspaceId, tab, query, cursorTs, cursorSource, cursorId, limit } =
    params;

  const args: unknown[] = [workspaceId, limit];
  let idx = 3;
  let whereExtra = tabFilter(tab);

  if (query) {
    whereExtra += ` AND name ILIKE '%' || $${idx} || '%'`;
    args.push(query);
    idx++;
  }

  if (cursorTs && cursorSource && cursorId) {
    whereExtra += ` AND (created_at, source, asset_id) < ($${idx}::timestamptz, $${idx + 1}, $${idx + 2})`;
    args.push(cursorTs, cursorSource, cursorId);
    idx += 3;
  }

  const sql = `
    SELECT *
    FROM library_assets_view
    WHERE workspace_id = $1
      ${whereExtra}
    ORDER BY created_at DESC, source ASC, asset_id ASC
    LIMIT $2
  `;

  const r = await pgPool.query<RawAssetRow>(sql, args);
  return r.rows;
}

/* ── Count assets per tab ────────────────────────── */

export async function countAssets(
  workspaceId: string,
): Promise<LibraryCounts> {
  const sql = `
    SELECT
      COUNT(*)::integer                                                                    AS "all",
      COUNT(*) FILTER (WHERE source = 'artifact')::integer                                 AS artifact,
      COUNT(*) FILTER (WHERE mime LIKE 'image/%')::integer                                 AS image,
      COUNT(*) FILTER (WHERE source IN ('upload','direct_upload') AND mime NOT LIKE 'image/%')::integer AS file
    FROM library_assets_view
    WHERE workspace_id = $1
  `;
  const r = await pgPool.query<LibraryCounts>(sql, [workspaceId]);
  const row = r.rows[0];
  return {
    all: row?.all ?? 0,
    artifact: row?.artifact ?? 0,
    image: row?.image ?? 0,
    file: row?.file ?? 0,
  };
}

/* ── Get single asset by composite key ───────────── */

export async function getAssetById(
  source: AssetSource,
  assetId: string,
  workspaceId: string,
): Promise<RawAssetRow | null> {
  const sql = `
    SELECT *
    FROM library_assets_view
    WHERE source = $1 AND asset_id = $2 AND workspace_id = $3
    LIMIT 1
  `;
  const r = await pgPool.query<RawAssetRow>(sql, [source, assetId, workspaceId]);
  return r.rows[0] ?? null;
}

/* ── Soft-delete a direct_upload ─────────────────── */

export async function softDeleteUpload(
  id: string,
  userId: number,
): Promise<boolean> {
  const r = await pgPool.query(
    `UPDATE library_uploads
     SET deleted_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/* ── Insert a new direct upload record ───────────── */

export async function insertDirectUpload(params: {
  userId: number;
  workspaceId: string;
  fileName: string;
  mimeType: string;
  ext: string;
  sizeBytes: number;
  filePath: string;
}): Promise<string> {
  const r = await pgPool.query<{ id: string }>(
    `INSERT INTO library_uploads
       (user_id, workspace_id, file_name, mime_type, ext, size_bytes, file_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      params.userId,
      params.workspaceId,
      params.fileName,
      params.mimeType,
      params.ext,
      params.sizeBytes,
      params.filePath,
    ],
  );
  return r.rows[0].id;
}
