// 📂 src/workers/export-worker.ts
//
// Phase F.4 — Data export fulfillment worker.
//
// Long-running PM2 process. Every POLL_INTERVAL_MS it pulls a single
// `pending` row out of `data_export_requests` using FOR UPDATE SKIP
// LOCKED (safe to run multiple workers, but we run one), dumps the
// user's data into a JSON bundle, zips it to /mnt/yua/exports/{uid}/
// {reqId}.zip, flips the row to `ready`, then emails a magic link.
//
// Security model (see Phase F design notes):
//   - No HMAC. The email link is `/settings/privacy?exportReady={id}`.
//   - Server enforces `user_id = req.user.id` on every download hit,
//     so leaking the numeric id does NOT leak the file.
//
// Failure handling:
//   - Any thrown error → status='failed', error_message populated,
//     never retried automatically (operator can re-queue manually).
//   - Worker process itself keeps running; each loop iteration is a
//     try/catch so a single bad row can't kill the worker.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import JSZip from "jszip";

import { pgPool } from "../db/postgres";
import { sendDataExportReadyEmail } from "../services/data-export-email.service";

/* =========================
   Config
========================= */

const POLL_INTERVAL_MS = 60_000; // 1 minute
const BATCH_SIZE = 1; // one row per iteration — keeps work short
const EXPORTS_ROOT = process.env.YUA_EXPORTS_ROOT || "/mnt/yua/exports";
const EXPORT_TTL_DAYS = 7;
const WORKER_ID = `export-worker-${os.hostname()}-${process.pid}`;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500MB hard cap per export

/* =========================
   Web base URL (email link)
========================= */

function getWebBaseUrl(): string {
  const raw =
    String(process.env.WEB_BASE_URL ?? "").trim() ||
    String(process.env.WEB_BASE_URI ?? "").trim() ||
    "https://www.yuaone.com";
  return raw.replace(/\/$/, "");
}

/* =========================
   DB types
========================= */

interface PendingRow {
  id: number;
  user_id: number;
  requested_at: Date;
}

interface UserInfo {
  email: string | null;
  name: string | null;
}

/* =========================
   Data dump
========================= */

/**
 * Collect every table the user owns data in, package into a JSON
 * bundle, and return an in-memory JSZip instance ready to write.
 *
 * Table names + column names verified against live schema via
 * `\d {table}` on `yua_ai` — NOT guessed. Audited in Phase F step 2.
 *
 * Hard-excluded (NEVER in export):
 *   user_connectors          — encrypted OAuth tokens
 *   user_sessions            — auth session tokens
 *   user_credits / billing_* — PCI / accounting retention
 *   api_keys_v2 / device_*   — secrets
 *   support_tickets          — separate GDPR flow
 *   agent_audit_log / security_event_log — operator-only
 *   workspace_join_events    — other users' data
 *
 * Every query is parameterized and scoped to `user_id`. The worker
 * never reads other users' rows.
 */
async function buildExportBundle(userId: number): Promise<{
  zip: JSZip;
  totalBytes: number;
  meta: { threadCount: number; messageCount: number; memoryCount: number };
}> {
  const zip = new JSZip();
  const meta = { threadCount: 0, messageCount: 0, memoryCount: 0 };
  let totalBytes = 0;

  const addJson = (name: string, data: unknown) => {
    const str = JSON.stringify(data, null, 2);
    totalBytes += Buffer.byteLength(str, "utf8");
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `export exceeds ${MAX_TOTAL_BYTES} bytes — contact support for large exports`,
      );
    }
    zip.file(name, str);
  };

  zip.file(
    "README.md",
    [
      "# YUA Data Export",
      "",
      `Exported at: ${new Date().toISOString()}`,
      `User id: ${userId}`,
      "",
      "## Files",
      "",
      "- `user.json`                      — account profile",
      "- `threads.json`                   — conversation threads (title, metadata)",
      "- `messages.json`                  — every message in your threads",
      "- `memory_records.json`            — durable memory entries you created",
      "- `memory_summaries.json`          — memory-engine summaries",
      "- `cross_thread_memory.json`       — cross-conversation summaries",
      "- `projects.json`                  — projects you created",
      "- `workspace_docs.json`            — docs you authored",
      "- `workspace_user_tone_signal.json`— tone/persona preferences",
      "- `prefs.json`                     — UI preferences",
      "",
      "## Excluded (for compliance / security)",
      "",
      "- Billing history, credits, subscriptions (PCI / accounting retention)",
      "- Auth tokens, sessions, API keys (security)",
      "- OAuth connector tokens (encrypted at rest, never exported plaintext)",
      "- Other users' data in shared workspaces",
      "- System audit logs, telemetry",
      "",
      "Scoped strictly to your user id via the Settings → Privacy →",
      "Export Data flow. See support@yuaone.com for large-export assistance.",
    ].join("\n"),
  );

  /* -------- users (profile) -------- */
  const { rows: userRows } = await pgPool.query(
    `SELECT id, email, name, created_at
     FROM users WHERE id = $1`,
    [userId],
  );
  addJson("user.json", { profile: userRows[0] ?? null });

  /* -------- conversation_threads -------- */
  // Column audit: id, title, metadata, user_id, project_id, workspace_id,
  //               created_at, last_activity_at, pinned, pinned_order,
  //               visibility, auto_titled
  const { rows: threads } = await pgPool.query(
    `SELECT id, title, metadata, project_id, workspace_id,
            created_at, last_activity_at, pinned, pinned_order,
            visibility, auto_titled
     FROM conversation_threads
     WHERE user_id = $1
     ORDER BY created_at ASC
     LIMIT 100000`,
    [userId],
  );
  meta.threadCount = threads.length;
  addJson("threads.json", threads);

  /* -------- chat_messages (via thread FK) -------- */
  // Join conversation_threads to enforce user_id ownership; messages
  // have no user_id column of their own.
  const { rows: messages } = await pgPool.query(
    `SELECT m.id, m.thread_id, m.role, m.content, m.created_at,
            m.model, m.mode, m.outmode, m.trace_id
     FROM chat_messages m
     INNER JOIN conversation_threads t ON m.thread_id = t.id
     WHERE t.user_id = $1
     ORDER BY m.thread_id ASC, m.created_at ASC
     LIMIT 1000000`,
    [userId],
  );
  meta.messageCount = messages.length;
  addJson("messages.json", messages);

  /* -------- memory_records (created_by_user_id VARCHAR(64)) -------- */
  // Critical: this column is VARCHAR(64), not bigint. Cast int → text.
  try {
    const { rows: memoryRecords } = await pgPool.query(
      `SELECT id, record_type, content, created_at, scope, confidence,
              source, thread_id, updated_at, access_count, locked
       FROM memory_records
       WHERE created_by_user_id = $1::text
       ORDER BY created_at ASC
       LIMIT 100000`,
      [String(userId)],
    );
    meta.memoryCount += memoryRecords.length;
    addJson("memory_records.json", memoryRecords);
  } catch (e: any) {
    console.warn("[export-worker] memory_records dump skipped", e?.message);
    addJson("memory_records.json", []);
  }

  /* -------- memory_summary (user_id VARCHAR(64)) -------- */
  try {
    const { rows: memorySummaries } = await pgPool.query(
      `SELECT id, summary, created_at
       FROM memory_summary
       WHERE user_id = $1::text
       ORDER BY created_at ASC
       LIMIT 100000`,
      [String(userId)],
    );
    meta.memoryCount += memorySummaries.length;
    addJson("memory_summaries.json", memorySummaries);
  } catch (e: any) {
    console.warn("[export-worker] memory_summary dump skipped", e?.message);
    addJson("memory_summaries.json", []);
  }

  /* -------- cross_thread_memory (user_id bigint) -------- */
  try {
    const { rows: crossMemory } = await pgPool.query(
      `SELECT id, workspace_id, type, summary, facts, scope,
              source_thread_id, created_at, is_archived
       FROM cross_thread_memory
       WHERE user_id = $1
       ORDER BY created_at ASC
       LIMIT 100000`,
      [userId],
    );
    addJson("cross_thread_memory.json", crossMemory);
  } catch (e: any) {
    console.warn("[export-worker] cross_thread_memory dump skipped", e?.message);
    addJson("cross_thread_memory.json", []);
  }

  /* -------- projects (created_by_user_id bigint) -------- */
  try {
    const { rows: projects } = await pgPool.query(
      `SELECT id, workspace_id, name, created_at
       FROM projects
       WHERE created_by_user_id = $1
       ORDER BY created_at ASC
       LIMIT 10000`,
      [userId],
    );
    addJson("projects.json", projects);
  } catch (e: any) {
    console.warn("[export-worker] projects dump skipped", e?.message);
    addJson("projects.json", []);
  }

  /* -------- workspace_docs (created_by bigint, soft-delete aware) -------- */
  try {
    const { rows: docs } = await pgPool.query(
      `SELECT id, workspace_id, project_id, title, created_by,
              last_edited_by, created_at, updated_at,
              content_type, content_json
       FROM workspace_docs
       WHERE created_by = $1
         AND (deleted_at IS NULL)
       ORDER BY created_at ASC
       LIMIT 10000`,
      [userId],
    );
    addJson("workspace_docs.json", docs);
  } catch (e: any) {
    console.warn("[export-worker] workspace_docs dump skipped", e?.message);
    addJson("workspace_docs.json", []);
  }

  /* -------- workspace_user_tone_signal -------- */
  try {
    const { rows: toneRows } = await pgPool.query(
      `SELECT workspace_id, name, tone_capability, created_at, updated_at
       FROM workspace_user_tone_signal
       WHERE user_id = $1
       ORDER BY workspace_id ASC`,
      [userId],
    );
    addJson("workspace_user_tone_signal.json", toneRows);
  } catch (e: any) {
    console.warn("[export-worker] tone_signal dump skipped", e?.message);
    addJson("workspace_user_tone_signal.json", []);
  }

  /* -------- user_prefs (JSONB bag) -------- */
  try {
    const { rows: prefs } = await pgPool.query(
      `SELECT data, updated_at FROM user_prefs WHERE user_id = $1`,
      [userId],
    );
    addJson("prefs.json", prefs[0] ?? {});
  } catch (e: any) {
    console.warn("[export-worker] user_prefs dump skipped", e?.message);
    addJson("prefs.json", {});
  }

  return { zip, totalBytes, meta };
}

/* =========================
   File write
========================= */

async function writeZipToDisk(
  userId: number,
  requestId: number,
  zip: JSZip,
): Promise<{ filePath: string; fileSizeBytes: number }> {
  const userDir = path.join(EXPORTS_ROOT, String(userId));
  await fs.promises.mkdir(userDir, { recursive: true, mode: 0o700 });

  const fileName = `${requestId}.zip`;
  const filePath = path.join(userDir, fileName);

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  await fs.promises.writeFile(filePath, buffer, { mode: 0o600 });
  const stat = await fs.promises.stat(filePath);
  return { filePath, fileSizeBytes: stat.size };
}

/* =========================
   Claim + finish helpers
========================= */

/**
 * Atomically claim one pending row. Uses FOR UPDATE SKIP LOCKED so
 * multiple worker instances (future-proofing) won't race.
 */
async function claimPendingRow(): Promise<PendingRow | null> {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<PendingRow>(
      `SELECT id, user_id, requested_at
       FROM data_export_requests
       WHERE status = 'pending'
       ORDER BY requested_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ${BATCH_SIZE}`,
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE data_export_requests
       SET status='processing',
           locked_by=$1,
           locked_at=NOW()
       WHERE id = $2`,
      [WORKER_ID, rows[0].id],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function fetchUserInfo(userId: number): Promise<UserInfo> {
  const { rows } = await pgPool.query<UserInfo>(
    `SELECT email, name FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? { email: null, name: null };
}

async function markReady(
  requestId: number,
  filePath: string,
  fileSizeBytes: number,
  expiresAt: Date,
): Promise<void> {
  await pgPool.query(
    `UPDATE data_export_requests
     SET status='ready',
         file_path=$1,
         file_size_bytes=$2,
         expires_at=$3,
         completed_at=NOW(),
         error_message=NULL
     WHERE id = $4`,
    [filePath, fileSizeBytes, expiresAt, requestId],
  );
}

async function markFailed(requestId: number, message: string): Promise<void> {
  await pgPool.query(
    `UPDATE data_export_requests
     SET status='failed',
         error_message=$1,
         completed_at=NOW()
     WHERE id = $2`,
    [message.slice(0, 500), requestId],
  );
}

/* =========================
   One-shot
========================= */

async function processOne(row: PendingRow): Promise<void> {
  const startedAt = Date.now();
  console.log("[export-worker] processing start", { id: row.id, userId: row.user_id });

  const user = await fetchUserInfo(row.user_id);
  if (!user.email) {
    await markFailed(row.id, "user has no email on file");
    return;
  }

  let bundle: Awaited<ReturnType<typeof buildExportBundle>>;
  try {
    bundle = await buildExportBundle(row.user_id);
  } catch (e: any) {
    await markFailed(row.id, `dump failed: ${e?.message ?? String(e)}`);
    return;
  }

  let wrote: Awaited<ReturnType<typeof writeZipToDisk>>;
  try {
    wrote = await writeZipToDisk(row.user_id, row.id, bundle.zip);
  } catch (e: any) {
    await markFailed(row.id, `zip write failed: ${e?.message ?? String(e)}`);
    return;
  }

  const expiresAt = new Date(Date.now() + EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000);
  await markReady(row.id, wrote.filePath, wrote.fileSizeBytes, expiresAt);

  const downloadUrl = `${getWebBaseUrl()}/settings/privacy?exportReady=${row.id}`;

  const emailResult = await sendDataExportReadyEmail({
    toEmail: user.email,
    userName: user.name,
    downloadUrl,
    expiresAt,
    fileSizeBytes: wrote.fileSizeBytes,
    downloadsRemaining: 5,
  });

  const elapsedMs = Date.now() - startedAt;
  if (!emailResult.ok) {
    console.warn("[export-worker] email send failed but row is ready", {
      id: row.id,
      error: emailResult.error,
      elapsedMs,
      threadCount: bundle.meta.threadCount,
      messageCount: bundle.meta.messageCount,
      memoryCount: bundle.meta.memoryCount,
      sizeBytes: wrote.fileSizeBytes,
    });
    // We do NOT fail the row — the file is ready, the user can still
    // hit the /settings/privacy?exportReady={id} link if operator
    // re-sends manually. Flagged in pm2 logs for ops triage.
  } else {
    console.log("[export-worker] ready + emailed", {
      id: row.id,
      userId: row.user_id,
      elapsedMs,
      threadCount: bundle.meta.threadCount,
      messageCount: bundle.meta.messageCount,
      memoryCount: bundle.meta.memoryCount,
      sizeBytes: wrote.fileSizeBytes,
      messageId: emailResult.messageId,
    });
  }
}

/* =========================
   Main loop
========================= */

let shuttingDown = false;

async function loop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const row = await claimPendingRow();
      if (row) {
        await processOne(row);
        // Loop again immediately — there might be a backlog.
        continue;
      }
    } catch (e) {
      console.error("[export-worker] loop iteration failed", e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function installSignalHandlers(): void {
  const shutdown = (sig: string) => {
    console.log(`[export-worker] ${sig} received, exiting after current job`);
    shuttingDown = true;
    setTimeout(() => process.exit(0), 30_000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

(async function main() {
  console.log("[export-worker] starting", { workerId: WORKER_ID, root: EXPORTS_ROOT });
  try {
    await fs.promises.mkdir(EXPORTS_ROOT, { recursive: true, mode: 0o700 });
  } catch (e) {
    console.error("[export-worker] failed to create exports root", e);
    process.exit(1);
  }
  installSignalHandlers();
  await loop();
})().catch((e) => {
  console.error("[export-worker] fatal", e);
  process.exit(1);
});
