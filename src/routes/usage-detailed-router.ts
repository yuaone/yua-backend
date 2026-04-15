// 📂 yua-backend/src/routes/usage-detailed-router.ts
//
// GET /api/usage/detailed — structured view of the user's live usage state.
// Matches §4.7 of docs/plans/2026-04-11-yua-settings-claude-parity-design.md.
//
// Mount: `/api/usage` (see routes/index.ts — line 148 area). This router
// exposes a single path `/detailed` so the final URL is `/api/usage/detailed`.
// Route registration is Agent D's responsibility; line to add is documented
// in the Agent A report.
//
// Owner: Agent A (Batch 3 — Usage System Backend)

import { Router, type Request, type Response } from "express";
import { PLAN_CONFIGS, type PlanId } from "yua-shared/plan/plan-pricing";
import { pgPool } from "../db/postgres";
import { redisPub } from "../db/redis";
import { getOrInitSession } from "../ai/billing/usage-session-tracker";
import {
  getWeekly,
  getNextWeekResetIsoForUser,
} from "../ai/billing/usage-weekly-tracker";

const router = Router();

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function currentMonthKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function nextMonthResetIsoKst(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  // First day of next month in KST wall-clock
  const nextMonthUtcMs = Date.UTC(y, m + 1, 1, 0, 0, 0) - KST_OFFSET_MS;
  const kstWall = new Date(nextMonthUtcMs + KST_OFFSET_MS);
  const yy = kstWall.getUTCFullYear();
  const mm = String(kstWall.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kstWall.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}T00:00:00+09:00`;
}

function percent(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const p = (used / limit) * 100;
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

// SSOT for plan tier: workspace_plan_state is what the sidebar renders and
// what compute-gate actually enforces. req.user.planTier comes from
// billing_subscriptions, which diverges if a workspace has an override
// (admin grant, enterprise seat, promo). Reading from workspace_plan_state
// here keeps the usage panel consistent with the sidebar plan badge.
async function resolveWorkspacePlanTier(
  userId: number,
  fallback: PlanId,
): Promise<PlanId> {
  try {
    const row = await pgPool.query<{ tier: string }>(
      `SELECT wps.tier
         FROM workspace_plan_state wps
         INNER JOIN workspaces w ON w.id = wps.workspace_id
         WHERE w.owner_user_id = $1 AND wps.status = 'active'
         ORDER BY wps.updated_at DESC
         LIMIT 1`,
      [userId],
    );
    const tier = row.rows[0]?.tier;
    if (tier && tier in PLAN_CONFIGS) return tier as PlanId;
  } catch (err) {
    console.warn("[usage-detailed] workspace_plan_state lookup failed", err);
  }
  return fallback;
}

router.get("/detailed", async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const fallbackTier: PlanId = (req.user?.planTier ?? "free") as PlanId;
  const planTier: PlanId = await resolveWorkspacePlanTier(userId, fallbackTier);
  const limits = PLAN_CONFIGS[planTier] ?? PLAN_CONFIGS.free;
  const now = new Date();
  const asOf = now.toISOString();

  // ─── Session ─────────────────────────────────────────────────────────
  const sess = await getOrInitSession(userId, planTier).catch(() => ({
    windowStart: now.getTime(),
    msgCount: 0,
    costUsdCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    planTierAtStart: planTier,
  }));

  const windowHours = limits.session.windowHours;
  const windowMs = Math.round(windowHours * 3600 * 1000);
  const sessionResetInSeconds = Math.max(
    0,
    Math.round((sess.windowStart + windowMs - now.getTime()) / 1000)
  );

  const sessionMessagesLimit = limits.session.messagesPerWindow;
  const sessionCostLimit = limits.session.costCapUsdPerWindow;
  const sessionCostUsed = sess.costUsdCents / 100;

  const totalTokens =
    (sess.inputTokens ?? 0) +
    (sess.outputTokens ?? 0) +
    (sess.cachedTokens ?? 0);

  const sessionBlock = {
    window: {
      hours: windowHours,
      startedAt: new Date(sess.windowStart).toISOString(),
    },
    messages: {
      used: sess.msgCount,
      limit: sessionMessagesLimit,
      percent: percent(sess.msgCount, sessionMessagesLimit),
    },
    cost: {
      usedUsd: Number(sessionCostUsed.toFixed(4)),
      limitUsd: sessionCostLimit,
      percent: percent(sessionCostUsed, sessionCostLimit),
    },
    tokens: {
      input: sess.inputTokens ?? 0,
      output: sess.outputTokens ?? 0,
      cached: sess.cachedTokens ?? 0,
      total: totalTokens,
      limit: limits.session.tokensPerWindow ?? 0,
      percent: limits.session.tokensPerWindow ? percent(totalTokens, limits.session.tokensPerWindow) : 0,
    },
    resetInSeconds: sessionResetInSeconds,
  };

  // ─── Weekly ──────────────────────────────────────────────────────────
  const weekly = await getWeekly(userId).catch(() => ({
    weekStartKst: "",
    messages: 0,
    costUsd: 0,
  }));
  const weeklyLimit = limits.weekly.messages; // 0 = unlimited
  // User-anchored rolling 7-day reset — each user's week ends on their own
  // cycle, not calendar Monday.
  const weeklyResetAt = await getNextWeekResetIsoForUser(userId, now).catch(
    () => now.toISOString(),
  );
  const weeklyBlock = {
    weekStartKst: weekly.weekStartKst || weeklyResetAt.slice(0, 10),
    messages: {
      used: weekly.messages,
      limit: weeklyLimit,
      percent: weeklyLimit > 0 ? percent(weekly.messages, weeklyLimit) : 0,
    },
    cost: {
      usedUsd: Number((weekly.costUsd || 0).toFixed(4)),
    },
    resetAt: weeklyResetAt,
  };

  // ─── Spend (monthly) ─────────────────────────────────────────────────
  const monthKey = currentMonthKey(now);
  let spendUsedCents = 0;
  try {
    const raw = await redisPub.get(`usage:spend:user:${userId}:${monthKey}`);
    spendUsedCents = raw ? Number(raw) || 0 : 0;
  } catch {
    spendUsedCents = 0;
  }

  let capUsd: number | null = null;
  try {
    const capRow = await pgPool.query<{ monthly_cap_usd: string | null }>(
      `SELECT monthly_cap_usd FROM user_billing_cap WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const raw = capRow.rows[0]?.monthly_cap_usd;
    capUsd = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
  } catch {
    capUsd = null;
  }

  const spendBlock = {
    monthKey,
    usedUsd: Number((spendUsedCents / 100).toFixed(4)),
    capUsd,
    capHardMaxUsd: limits.spendingCap.monthlyHardMaxUsd,
    resetAt: nextMonthResetIsoKst(now),
  };

  // ─── Controls ────────────────────────────────────────────────────────
  const controls = {
    canAdjustCap: limits.spendingCap.monthlyHardMaxUsd > 0,
    canBuyTopUp: false,
  };

  // 🔥 FIX: 서버에서 직접 gate 상태 판단 → 프론트가 즉시 locked 인식
  const { checkUsage } = await import("../ai/billing/usage-gate.js");
  const gateResult = await checkUsage(userId, planTier, 0, 0).catch(() => ({ ok: true, reason: "ok" as const }));
  const locked = !gateResult.ok;
  const gateResetInSeconds = (gateResult as any).resetInSeconds ?? sessionResetInSeconds;

  return res.json({
    planTier,
    asOf,
    locked,
    resetInSeconds: locked ? gateResetInSeconds : 0,
    reason: locked ? (gateResult as any).reason : null,
    session: sessionBlock,
    weekly: weeklyBlock,
    spend: spendBlock,
    controls,
  });
});

export default router;
