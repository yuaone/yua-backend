import { Response, NextFunction } from "express";
import { db } from "../db/mysql";
import { InstanceAuthedRequest } from "./instance-access-middleware";
import { type PlanId, PLAN_CONFIGS, normalizePlanId } from "yua-shared/plan/plan-pricing";

export async function requirePlanLimit(
  req: InstanceAuthedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const [[userRow]]: any = await db.query(
      `SELECT plan_id FROM users WHERE id = ? LIMIT 1`,
      [user.userId]
    );

    const plan: PlanId = normalizePlanId(userRow?.plan_id ?? "free");

    const [[cnt]]: any = await db.query(
      `SELECT COUNT(*) AS cnt FROM engine_instances WHERE user_id = ?`,
      [user.userId]
    );

    const maxInstances = PLAN_CONFIGS[plan].maxInstances;

    if (cnt.cnt >= maxInstances) {
      return res.status(403).json({
        ok: false,
        error: "plan_limit_exceeded",
      });
    }

    next();
  } catch (err) {
    console.error("Plan Limit Error:", err);
    return res.status(500).json({ ok: false });
  }
}
