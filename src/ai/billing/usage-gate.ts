// 📂 yua-backend/src/ai/billing/usage-gate.ts
//
// Pre-send usage gate. Called BEFORE each chat message actually goes to the
// LLM runtime. Returns the first block it finds, or `ok` to allow the message.
//
// Checks (in order):
//   1. Rolling session window (messages per window / cost per window)
//   2. Weekly message bucket (only if tier has weekly.messages > 0)
//   3. Monthly spend cap (only if user has an opt-in cap in user_billing_cap)
//
// Owner: Agent A (Batch 3 — Usage System Backend)
//
// NOTE — known race: the gate reads session state then the runtime increments
// on stream end. Two concurrent requests at the boundary can both see
// msgCount=44 and both pass (resulting in 46). Redis HINCRBY makes final state
// correct, so this is at most one extra message at the boundary per window —
// acceptable, not a security issue.

import { pgPool } from "../../db/postgres";
import { redisPub } from "../../db/redis";
import { PLAN_CONFIGS, type PlanId } from "yua-shared/plan/plan-pricing";
import { getOrInitSession } from "./usage-session-tracker";
import { getWeekly, getWeeklyAnchorMs, computeBucketStartMs } from "./usage-weekly-tracker";
import { fetchBalance } from "../../billing/lemonsqueezy/credit-grant";

export type GateReason =
  | "ok"
  | "credits_bypass"
  | "session_msg_cap"
  | "session_token_cap"
  | "session_cost_cap"
  | "weekly_msg_cap"
  | "daily_token_cap"
  | "monthly_token_cap"
  | "monthly_spend_cap";

export interface GateResult {
  ok: boolean;
  reason: GateReason;
  /** Seconds until the relevant bucket resets (only set for blocks). */
  resetInSeconds?: number;
  /** Cap value in USD (for cost/spend blocks). */
  capUsd?: number;
  /** Used so far in USD (for cost/spend blocks). */
  usedUsd?: number;
  /** Credit balance in USD cents (only set for credits_bypass). */
  creditsBalanceCents?: number;
}

function currentMonthKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function secondsUntil(targetMs: number): number {
  return Math.max(0, Math.round((targetMs - Date.now()) / 1000));
}

function secondsToNextMonthReset(now: Date = new Date()): number {
  // Reset at day 1 of next month, 00:00 KST (approximate with UTC — close enough for UX).
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const nextMonthUtcMs = Date.UTC(y, m + 1, 1, 0, 0, 0) - 9 * 60 * 60 * 1000;
  return secondsUntil(nextMonthUtcMs);
}

function kstWindowStart(
  now: Date,
  kind: "day" | "month",
): { startUtc: Date; endUtc: Date } {
  const offsetMs = 9 * 60 * 60 * 1000;
  const localMs = now.getTime() + offsetMs;
  const local = new Date(localMs);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();

  if (kind === "day") {
    const startUtcMs = Date.UTC(y, m, d, 0, 0, 0) - offsetMs;
    const endUtcMs = Date.UTC(y, m, d + 1, 0, 0, 0) - offsetMs;
    return { startUtc: new Date(startUtcMs), endUtc: new Date(endUtcMs) };
  }

  const startUtcMs = Date.UTC(y, m, 1, 0, 0, 0) - offsetMs;
  const endUtcMs = Date.UTC(y, m + 1, 1, 0, 0, 0) - offsetMs;
  return { startUtc: new Date(startUtcMs), endUtc: new Date(endUtcMs) };
}

async function readWindowTokens(
  userId: number,
  kind: "day" | "month",
): Promise<number> {
  const now = new Date();
  const { startUtc, endUtc } = kstWindowStart(now, kind);
  const r = await pgPool.query<{ used_tokens: string | null }>(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cached_tokens + reasoning_tokens), 0)::bigint AS used_tokens
       FROM workspace_usage_log
      WHERE user_id = $1
        AND created_at >= $2
        AND created_at < $3`,
    [userId, startUtc.toISOString(), endUtc.toISOString()],
  );
  return Number(r.rows[0]?.used_tokens ?? 0) || 0;
}

function secondsToNextDayReset(now: Date = new Date()): number {
  const { endUtc } = kstWindowStart(now, "day");
  return secondsUntil(endUtc.getTime());
}

/**
 * Helper: check if the user has credit balance and should bypass a soft cap.
 * Monthly spend cap blocks are NEVER bypassed — that's a user-defined hard
 * limit. Session/weekly caps CAN be bypassed if balance >= estimated cost.
 */
async function tryCreditsBypass(
  userId: number,
  estimatedCostUsd: number
): Promise<number | null> {
  try {
    const balanceCents = await fetchBalance(userId);
    const neededCents = Math.max(1, Math.round(estimatedCostUsd * 100));
    if (balanceCents >= neededCents) {
      return balanceCents;
    }
  } catch (err) {
    console.warn("[usage-gate] credits balance check failed", err);
  }
  return null;
}

/**
 * Check whether a user is allowed to send one more chat message.
 * `estimatedCostUsd` is best-effort — callers can pass 0 if unknown.
 */
export async function checkUsage(
  userId: number,
  planTier: PlanId,
  estimatedCostUsd: number,
  estimatedTokens: number = 0,
): Promise<GateResult> {
  const limits = PLAN_CONFIGS[planTier];
  if (!limits) {
    return { ok: true, reason: "ok" };
  }

  // ─── 1. Session window ───────────────────────────────────────────────
  try {
    const sess = await getOrInitSession(userId, planTier);
    const windowMs = Math.round(limits.session.windowHours * 3600 * 1000);
    const resetInSeconds = Math.max(
      0,
      Math.round((sess.windowStart + windowMs - Date.now()) / 1000)
    );

    if (
      limits.session.messagesPerWindow > 0 &&
      sess.msgCount >= limits.session.messagesPerWindow
    ) {
      const bypass = await tryCreditsBypass(userId, estimatedCostUsd);
      if (bypass != null) {
        return {
          ok: true,
          reason: "credits_bypass",
          creditsBalanceCents: bypass,
        };
      }
      return {
        ok: false,
        reason: "session_msg_cap",
        resetInSeconds,
      };
    }

    if (limits.session.tokensPerWindow > 0) {
      const sessionTokens =
        (sess.inputTokens ?? 0) +
        (sess.outputTokens ?? 0) +
        (sess.cachedTokens ?? 0);
      const projectedTokens = sessionTokens + Math.max(0, Math.round(estimatedTokens));
      if (projectedTokens >= limits.session.tokensPerWindow) {
        const bypass = await tryCreditsBypass(userId, estimatedCostUsd);
        if (bypass != null) {
          return {
            ok: true,
            reason: "credits_bypass",
            creditsBalanceCents: bypass,
          };
        }
        return {
          ok: false,
          reason: "session_token_cap",
          resetInSeconds,
        };
      }
    }

    if (limits.session.costCapUsdPerWindow > 0) {
      const capCents = Math.round(limits.session.costCapUsdPerWindow * 100);
      const projected =
        sess.costUsdCents +
        Math.max(0, Math.round(estimatedCostUsd * 100));
      if (projected >= capCents) {
        const bypass = await tryCreditsBypass(userId, estimatedCostUsd);
        if (bypass != null) {
          return {
            ok: true,
            reason: "credits_bypass",
            creditsBalanceCents: bypass,
          };
        }
        return {
          ok: false,
          reason: "session_cost_cap",
          resetInSeconds,
          capUsd: limits.session.costCapUsdPerWindow,
          usedUsd: sess.costUsdCents / 100,
        };
      }
    }
  } catch (err) {
    console.warn("[usage-gate] session check failed", err);
    // Fail-open on Redis failure — better than hard-blocking the whole product.
  }

  // ─── 2. Weekly message bucket ────────────────────────────────────────
  if (limits.weekly.messages > 0) {
    try {
      const wk = await getWeekly(userId);
      if (wk.messages >= limits.weekly.messages) {
        const bypass = await tryCreditsBypass(userId, estimatedCostUsd);
        if (bypass != null) {
          return {
            ok: true,
            reason: "credits_bypass",
            creditsBalanceCents: bypass,
          };
        }
        // Anchor-based rolling 7-day reset (not calendar Monday)
        const anchorMs = await getWeeklyAnchorMs(userId);
        const bucketStartMs = computeBucketStartMs(anchorMs, Date.now());
        const bucketEndMs = bucketStartMs + 7 * 24 * 60 * 60 * 1000;
        return {
          ok: false,
          reason: "weekly_msg_cap",
          resetInSeconds: secondsUntil(bucketEndMs),
        };
      }
    } catch (err) {
      console.warn("[usage-gate] weekly check failed", err);
    }
  }

  // ─── 3. Daily / monthly token budget ────────────────────────────────
  if (limits.chat.perDayTokens > 0) {
    try {
      const usedDailyTokens = await readWindowTokens(userId, "day");
      const projectedDailyTokens =
        usedDailyTokens + Math.max(0, Math.round(estimatedTokens));
      if (projectedDailyTokens >= limits.chat.perDayTokens) {
        return {
          ok: false,
          reason: "daily_token_cap",
          resetInSeconds: secondsToNextDayReset(),
        };
      }
    } catch (err) {
      console.warn("[usage-gate] daily token check failed", err);
    }
  }

  if (limits.chat.perMonthTokens > 0) {
    try {
      const usedMonthlyTokens = await readWindowTokens(userId, "month");
      const projectedMonthlyTokens =
        usedMonthlyTokens + Math.max(0, Math.round(estimatedTokens));
      if (projectedMonthlyTokens >= limits.chat.perMonthTokens) {
        return {
          ok: false,
          reason: "monthly_token_cap",
          resetInSeconds: secondsToNextMonthReset(),
        };
      }
    } catch (err) {
      console.warn("[usage-gate] monthly token check failed", err);
    }
  }

  // ─── 3. Monthly spend cap (opt-in via user_billing_cap) ──────────────
  try {
    const capRow = await pgPool.query<{ monthly_cap_usd: string | null }>(
      `SELECT monthly_cap_usd FROM user_billing_cap WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const capUsdRaw = capRow.rows[0]?.monthly_cap_usd;
    const capUsd =
      capUsdRaw != null && Number.isFinite(Number(capUsdRaw))
        ? Number(capUsdRaw)
        : null;
    if (capUsd != null && capUsd > 0) {
      const monthKey = currentMonthKey();
      const spendKey = `usage:spend:user:${userId}:${monthKey}`;
      let usedCents = 0;
      try {
        const raw = await redisPub.get(spendKey);
        usedCents = raw ? Number(raw) || 0 : 0;
      } catch (err) {
        console.warn("[usage-gate] monthly spend read failed", err);
      }
      if (usedCents >= capUsd * 100) {
        return {
          ok: false,
          reason: "monthly_spend_cap",
          resetInSeconds: secondsToNextMonthReset(),
          capUsd,
          usedUsd: usedCents / 100,
        };
      }
    }
  } catch (err) {
    console.warn("[usage-gate] monthly cap check failed", err);
  }

  return { ok: true, reason: "ok" };
}
