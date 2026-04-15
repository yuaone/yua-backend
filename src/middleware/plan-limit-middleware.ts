// src/middleware/plan-limit-middleware.ts

import { Response, NextFunction } from "express";
import { db } from "../db/mysql";
import type { Request } from "express";
import { SubscriptionRepo } from "../db/repositories/subscription-repo";
import { type PlanId, PLAN_CONFIGS, normalizePlanId } from "yua-shared/plan/plan-pricing";

type AuthedRequest = Request & {
  user?: { userId: string };
};

export async function requirePlanLimit(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.user?.userId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const subscription = await SubscriptionRepo.getByUserId(req.user.userId);
    const plan: PlanId = normalizePlanId(subscription?.plan ?? "free");

    const [[cnt]]: any = await db.query(
      `SELECT COUNT(*) AS cnt FROM engine_instances WHERE user_id = ?`,
      [req.user.userId]
    );

    const maxInstances = PLAN_CONFIGS[plan].maxInstances;

    if (cnt.cnt >= maxInstances) {
      return res.status(403).json({
        ok: false,
        error: "plan_limit_exceeded",
        message: `Instance limit (${maxInstances}) exceeded for ${plan} plan`,
      });
    }

    next();
  } catch (err) {
    console.error("Plan Limit Error:", err);
    return res.status(500).json({ ok: false, error: "plan_limit_error" });
  }
}
