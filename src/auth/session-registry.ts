// 📂 src/auth/session-registry.ts
// 🔒 YUA Session Registry — Postgres `user_sessions` + Redis revoke blacklist
//
// Backing store:
//   - Postgres `user_sessions` (source of truth, list/revoke)
//   - Redis `session:revoked:{sessionId}` (fast revoke check for middleware)
//
// Usage:
//   registerSession({ userId, sessionId, deviceLabel, ipAddress, userAgent })
//   touchSession(sessionId)
//   listSessions(userId, currentSessionId)
//   revokeSession(sessionId)
//   revokeAllExcept(userId, keepSessionId)
//   isRevoked(sessionId)  ← fast path (Redis GET only)

import { pgPool } from "../db/postgres";
import { redisPub } from "../db/redis";

/* ======================================================
   Types
====================================================== */

export interface SessionRow {
  sessionId: string;
  userId: number;
  deviceLabel: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string; // ISO
  lastSeenAt: string; // ISO
  revokedAt: string | null;
  isCurrent?: boolean;
}

/* ======================================================
   Redis key helpers
====================================================== */

const REVOKE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function revokedKey(sessionId: string): string {
  return `session:revoked:${sessionId}`;
}

/* ======================================================
   Public API
====================================================== */

/**
 * Insert (or upsert) a login session row.
 * If the same session_id already exists, update last_seen_at.
 * Fire-and-forget friendly: errors logged, not thrown.
 */
export async function registerSession(params: {
  userId: number;
  sessionId: string;
  deviceLabel?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  const { userId, sessionId } = params;
  if (!sessionId || !userId) return;

  try {
    await pgPool.query(
      `INSERT INTO user_sessions
         (session_id, user_id, device_label, ip_address, user_agent, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4::inet, $5, NOW(), NOW())
       ON CONFLICT (session_id) DO UPDATE
         SET last_seen_at = NOW()`,
      [
        sessionId,
        userId,
        params.deviceLabel ?? null,
        params.ipAddress ?? null,
        params.userAgent ?? null,
      ]
    );
  } catch (err) {
    // Some IPs (IPv6 scoped, proxy chains) may not parse as inet — retry without IP.
    try {
      await pgPool.query(
        `INSERT INTO user_sessions
           (session_id, user_id, device_label, ip_address, user_agent, created_at, last_seen_at)
         VALUES ($1, $2, $3, NULL, $4, NOW(), NOW())
         ON CONFLICT (session_id) DO UPDATE
           SET last_seen_at = NOW()`,
        [sessionId, userId, params.deviceLabel ?? null, params.userAgent ?? null]
      );
    } catch (err2) {
      console.warn("[session-registry] registerSession failed:", err2);
    }
  }
}

/**
 * Bump last_seen_at for an active (non-revoked) session.
 * No-op if sessionId is unknown or already revoked.
 *
 * Race note: two concurrent touches both run UPDATE; later NOW() wins,
 * which is the correct semantic.
 */
export async function touchSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await pgPool.query(
      `UPDATE user_sessions
         SET last_seen_at = NOW()
       WHERE session_id = $1
         AND revoked_at IS NULL`,
      [sessionId]
    );
  } catch (err) {
    console.warn("[session-registry] touchSession failed:", err);
  }
}

/**
 * List all active sessions for a user, most-recent first.
 * Marks `isCurrent=true` on the row matching currentSessionId (if provided).
 */
export async function listSessions(
  userId: number,
  currentSessionId: string | null
): Promise<SessionRow[]> {
  const { rows } = await pgPool.query<{
    session_id: string;
    user_id: string | number;
    device_label: string | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
    last_seen_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT session_id, user_id, device_label,
            host(ip_address) AS ip_address,
            user_agent, created_at, last_seen_at, revoked_at
       FROM user_sessions
      WHERE user_id = $1
        AND revoked_at IS NULL
      ORDER BY last_seen_at DESC`,
    [userId]
  );

  return rows.map((r) => ({
    sessionId: r.session_id,
    userId: Number(r.user_id),
    deviceLabel: r.device_label,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    createdAt: new Date(r.created_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    isCurrent: currentSessionId != null && r.session_id === currentSessionId,
  }));
}

/**
 * Revoke a single session. Marks PG row as revoked + writes Redis blacklist
 * so middleware can reject future requests using that session id.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await pgPool.query(
    `UPDATE user_sessions
        SET revoked_at = NOW()
      WHERE session_id = $1
        AND revoked_at IS NULL`,
    [sessionId]
  );
  try {
    await redisPub.set(revokedKey(sessionId), "1", "EX", REVOKE_TTL_SECONDS);
  } catch (err) {
    console.warn("[session-registry] redis set revoked failed:", err);
  }
}

/**
 * Revoke every active session for a user except the one to keep.
 * Returns the number of rows revoked.
 */
export async function revokeAllExcept(
  userId: number,
  keepSessionId: string
): Promise<number> {
  // Fetch the ids we're about to revoke so we can blacklist them in Redis.
  const { rows } = await pgPool.query<{ session_id: string }>(
    `SELECT session_id
       FROM user_sessions
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND session_id <> $2`,
    [userId, keepSessionId]
  );

  if (rows.length === 0) return 0;

  await pgPool.query(
    `UPDATE user_sessions
        SET revoked_at = NOW()
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND session_id <> $2`,
    [userId, keepSessionId]
  );

  // Blacklist each revoked session in Redis (fire-and-forget per-key).
  for (const r of rows) {
    try {
      await redisPub.set(revokedKey(r.session_id), "1", "EX", REVOKE_TTL_SECONDS);
    } catch (err) {
      console.warn("[session-registry] redis set revoked failed:", err);
    }
  }

  return rows.length;
}

/**
 * Fast path: is this session id on the revoke blacklist?
 * Must be a single Redis GET — do NOT add a Postgres lookup here.
 * Returns false on any Redis error (fail-open; PG is the source of truth).
 */
export async function isRevoked(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const v = await redisPub.get(revokedKey(sessionId));
    return v != null;
  } catch {
    return false;
  }
}

/* ======================================================
   UA / device label parser (inline — no ua-parser-js dep)
====================================================== */

/**
 * Very small regex-based UA parser.
 * Returns something like "Chrome on macOS" or "Safari on iOS" — good enough
 * for the Account tab "active sessions" list. Not a security feature.
 */
export function parseDeviceLabel(ua: string | undefined | null): string {
  if (!ua || typeof ua !== "string") return "Unknown device";

  // OS family
  let os = "Unknown OS";
  if (/Windows NT/i.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/CrOS/i.test(ua)) os = "ChromeOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  // Browser family (order matters: Edge/Opera before Chrome, Chrome before Safari)
  let browser = "Unknown browser";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua)) browser = "Safari";
  else if (/curl\//i.test(ua)) browser = "curl";
  else if (/PostmanRuntime/i.test(ua)) browser = "Postman";

  return `${browser} on ${os}`;
}
