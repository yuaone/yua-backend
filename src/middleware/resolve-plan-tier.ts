// src/middleware/resolve-plan-tier.ts
// Populates req.user.planTier from the billing_subscriptions SSOT.
//
// Order of resolution:
//   1. Redis cache  (plan_tier:user:{id}, TTL 5 min)
//   2. Postgres billing_subscriptions (findActiveByUser)
//   3. Fallback to "free"
//
// Errors are swallowed — a billing DB outage must not block chat.

import { Request, Response, NextFunction } from "express";
import { redisPub } from "../db/redis";
import { findActiveByUser } from "../billing/lemonsqueezy/subscription-repo";
import type { PlanId } from "../types/plan-types";
import { pgPool } from "../db/postgres";
import { normalizePlanId } from "yua-shared/plan/plan-pricing";

const CACHE_TTL_SECONDS = 300;
const VALID_TIERS: ReadonlySet<PlanId> = new Set<PlanId>([
  "free",
  "pro",
  "business",
  "enterprise",
  "max",
]);

function normalizeTier(raw: string | null | undefined): PlanId {
  if (raw && VALID_TIERS.has(raw as PlanId)) return raw as PlanId;
  return "free";
}

const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  pro: 1,
  business: 2,
  enterprise: 3,
  max: 4,
};

async function reconcileWorkspaceTier(
  req: Request,
  billingTier: PlanId,
): Promise<void> {
  const workspaceId = req.workspace?.id;
  if (!workspaceId) return;

  try {
    const row = await pgPool.query<{ tier: string }>(
      `SELECT tier
         FROM workspace_plan_state
        WHERE workspace_id = $1
        LIMIT 1`,
      [workspaceId],
    );
    const workspaceTier = normalizePlanId(row.rows[0]?.tier ?? "free") as PlanId;

    if (workspaceTier !== billingTier) {
      console.warn("[resolve-plan-tier] subscription/workspace mismatch", {
        userId: req.user?.userId,
        workspaceId,
        billingTier,
        workspaceTier,
      });
    }

    // Billing is payment truth: never allow workspace tier to exceed paid tier.
    if (PLAN_RANK[workspaceTier] > PLAN_RANK[billingTier]) {
      await pgPool.query(
        `UPDATE workspace_plan_state
            SET tier = $2
          WHERE workspace_id = $1`,
        [workspaceId, billingTier],
      );
      console.warn("[resolve-plan-tier] workspace tier downgraded", {
        userId: req.user?.userId,
        workspaceId,
        from: workspaceTier,
        to: billingTier,
      });
    }
  } catch (err) {
    console.warn("[resolve-plan-tier] workspace reconciliation failed", err);
  }
}

export async function resolvePlanTier(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    return next();
  }

  const cacheKey = `plan_tier:user:${userId}`;

  try {
    const cached = await (redisPub as any).get(cacheKey);
    if (cached && typeof cached === "string") {
      req.user!.planTier = normalizeTier(cached);
      return next();
    }
  } catch (err) {
    console.warn("[resolve-plan-tier] redis get failed", err);
  }

  try {
    const sub = await findActiveByUser(userId);

    // Past_due grace period — a user whose card failed gets their plan for
    // 3 days after the period end, then silently drops to free. Without this
    // guard, past_due users would keep paid tier indefinitely until another
    // webhook fired.
    const PAST_DUE_GRACE_DAYS = 3;
    let tier: PlanId = "free";
    if (sub) {
      if (sub.status === "active" || sub.status === "trialing") {
        tier = normalizeTier(sub.planTier);
      } else if (sub.status === "past_due") {
        const endMs = sub.currentPeriodEnd
          ? Date.parse(sub.currentPeriodEnd)
          : null;
        if (endMs != null && Number.isFinite(endMs)) {
          const graceMs = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;
          if (Date.now() - endMs < graceMs) {
            tier = normalizeTier(sub.planTier);
          } else {
            tier = "free";
          }
        } else {
          // No period end → safer to drop to free immediately.
          tier = "free";
        }
      }
      // cancelled / expired / refunded / paused → free
    }

    req.user!.planTier = tier;
    await reconcileWorkspaceTier(req, tier);

    // Fire-and-forget cache set.
    (redisPub as any)
      .set(cacheKey, tier, "EX", CACHE_TTL_SECONDS)
      .catch((err: unknown) =>
        console.warn("[resolve-plan-tier] redis set failed", err)
      );

    return next();
  } catch (err) {
    console.warn("[resolve-plan-tier] db lookup failed", err);
    req.user!.planTier = "free";
    return next();
  }
}
