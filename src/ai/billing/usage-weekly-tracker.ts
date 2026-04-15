// 📂 yua-backend/src/ai/billing/usage-weekly-tracker.ts
//
// Weekly usage tracker (Postgres-backed with Redis anchor cache).
//
// Policy (2026-04-11 update): weekly window is a **rolling 7-day bucket
// anchored to the user's first recorded usage** (or subscription start if
// we ever wire that). NOT calendar Monday. This matches the product
// decision that each user gets their own fair-use clock starting from the
// moment they engage, so /settings/usage resets predictably "7 days from
// the last reset" rather than "next Monday".
//
// Anchor resolution:
//   1. Redis `usage:weekly_anchor:{userId}` — epoch ms, set once per user
//   2. If missing: set to NOW() and persist (365-day TTL, refreshed on write)
//
// Current bucket math:
//   anchor = user's first-seen epoch
//   elapsedMs = now - anchor
//   weekIndex = floor(elapsedMs / 7 days)
//   bucketStartMs = anchor + weekIndex * 7 days
//   bucketEndMs   = bucketStartMs + 7 days
//
// The DB column `week_start_kst DATE` still stores the date portion for
// the primary key — we just compute it from the bucket start instead of
// from a fixed Monday.
//
// Owner: Agent A (Batch 3) + rolling-anchor refactor (Batch 9)

import { pgPool } from "../../db/postgres";
import { redisPub } from "../../db/redis";

export interface WeeklyState {
  weekStartKst: string;  // "YYYY-MM-DD" of the current bucket start
  messages: number;
  costUsd: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ANCHOR_TTL_SECONDS = 60 * 60 * 24 * 365;
const ANCHOR_KEY = (userId: number) => `usage:weekly_anchor:${userId}`;

/**
 * Return (and lazily initialize) the user's weekly anchor epoch ms.
 * Idempotent — multiple callers all see the same anchor once it's set.
 */
export async function getWeeklyAnchorMs(userId: number): Promise<number> {
  const key = ANCHOR_KEY(userId);
  try {
    const raw = await (redisPub as any).get(key);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        // Refresh TTL on read so active users never lose their anchor
        (redisPub as any).expire(key, ANCHOR_TTL_SECONDS).catch(() => {});
        return n;
      }
    }
  } catch {
    /* noop */
  }

  // First time seeing this user — stamp anchor to NOW.
  const anchor = Date.now();
  try {
    await (redisPub as any).set(
      key,
      String(anchor),
      "EX",
      ANCHOR_TTL_SECONDS,
    );
  } catch {
    /* noop — next call will try again */
  }
  return anchor;
}

/**
 * Compute the current 7-day bucket start epoch ms for a given anchor.
 */
export function computeBucketStartMs(
  anchorMs: number,
  nowMs: number = Date.now(),
): number {
  if (!Number.isFinite(anchorMs) || anchorMs <= 0 || nowMs < anchorMs) {
    return nowMs;
  }
  const elapsed = nowMs - anchorMs;
  const weekIndex = Math.floor(elapsed / WEEK_MS);
  return anchorMs + weekIndex * WEEK_MS;
}

/**
 * Format an epoch ms as a KST-date "YYYY-MM-DD" for storage in user_usage_weekly.
 */
function toKstDateString(epochMs: number): string {
  const kstWall = new Date(epochMs + KST_OFFSET_MS);
  const y = kstWall.getUTCFullYear();
  const m = String(kstWall.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kstWall.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toKstIso(epochMs: number): string {
  const kstWall = new Date(epochMs + KST_OFFSET_MS);
  const y = kstWall.getUTCFullYear();
  const m = String(kstWall.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kstWall.getUTCDate()).padStart(2, "0");
  const hh = String(kstWall.getUTCHours()).padStart(2, "0");
  const mm = String(kstWall.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:00+09:00`;
}

/**
 * Legacy export retained for usage-gate.ts compatibility. Returns the
 * KST date string for the CALENDAR Monday (not anchor-based). Use only
 * where an anchor isn't available; prefer `getWeeklyAnchorMs` +
 * `computeBucketStartMs` for user-scoped math.
 */
export function getCurrentWeekStartKst(now: Date = new Date()): string {
  const kstWall = new Date(now.getTime() + KST_OFFSET_MS);
  const dow = kstWall.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  const monday = new Date(
    Date.UTC(
      kstWall.getUTCFullYear(),
      kstWall.getUTCMonth(),
      kstWall.getUTCDate() - daysFromMonday,
    ),
  );
  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(monday.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Read the current-bucket's usage for a user. Returns zero state if the
 * bucket has no row yet (i.e. the week just rolled — clean slate).
 */
export async function getWeekly(userId: number): Promise<WeeklyState> {
  const anchorMs = await getWeeklyAnchorMs(userId);
  const bucketStartMs = computeBucketStartMs(anchorMs, Date.now());
  const weekStart = toKstDateString(bucketStartMs);
  try {
    const r = await pgPool.query<{
      messages: number;
      cost_usd: string;
    }>(
      `SELECT messages, cost_usd
         FROM user_usage_weekly
        WHERE user_id = $1 AND week_start_kst = $2
        LIMIT 1`,
      [userId, weekStart],
    );
    if (r.rowCount === 0) {
      return { weekStartKst: weekStart, messages: 0, costUsd: 0 };
    }
    const row = r.rows[0]!;
    return {
      weekStartKst: weekStart,
      messages: Number(row.messages) || 0,
      costUsd: Number(row.cost_usd) || 0,
    };
  } catch (err) {
    console.warn("[usage-weekly-tracker] getWeekly failed", err);
    return { weekStartKst: weekStart, messages: 0, costUsd: 0 };
  }
}

/**
 * Upsert +1 message and +costUsd into the current bucket.
 */
export async function incrementWeekly(
  userId: number,
  costUsd: number,
): Promise<void> {
  const anchorMs = await getWeeklyAnchorMs(userId);
  const bucketStartMs = computeBucketStartMs(anchorMs, Date.now());
  const weekStart = toKstDateString(bucketStartMs);
  const safeCost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  try {
    await pgPool.query(
      `INSERT INTO user_usage_weekly (user_id, week_start_kst, messages, cost_usd, updated_at)
         VALUES ($1, $2, 1, $3, NOW())
         ON CONFLICT (user_id, week_start_kst)
         DO UPDATE SET
           messages = user_usage_weekly.messages + 1,
           cost_usd = user_usage_weekly.cost_usd + EXCLUDED.cost_usd,
           updated_at = NOW()`,
      [userId, weekStart, safeCost],
    );
  } catch (err) {
    console.warn("[usage-weekly-tracker] incrementWeekly failed", err);
  }
}

/**
 * ISO8601 for the END of the current bucket (= next reset).
 * Used by /api/usage/detailed to tell the UI when the bar flips.
 */
export async function getNextWeekResetIsoForUser(
  userId: number,
  now: Date = new Date(),
): Promise<string> {
  const anchorMs = await getWeeklyAnchorMs(userId);
  const bucketStartMs = computeBucketStartMs(anchorMs, now.getTime());
  const bucketEndMs = bucketStartMs + WEEK_MS;
  return toKstIso(bucketEndMs);
}

/**
 * Legacy export — non-user-scoped next reset based on calendar Monday.
 * Kept for backward compat; new code should use getNextWeekResetIsoForUser.
 */
export function getNextWeekResetIso(now: Date = new Date()): string {
  const currentMondayKstStr = getCurrentWeekStartKst(now);
  const [y, m, d] = currentMondayKstStr.split("-").map((x) => Number(x));
  const thisMondayUtcMs =
    Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 0, 0, 0) - KST_OFFSET_MS;
  const nextMondayUtcMs = thisMondayUtcMs + WEEK_MS;
  return toKstIso(nextMondayUtcMs);
}
