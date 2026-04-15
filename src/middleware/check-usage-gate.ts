import type { Request, Response, NextFunction } from "express";
import { checkUsage } from "../ai/billing/usage-gate";
import { normalizePlanId, type PlanId } from "yua-shared/plan/plan-pricing";

async function resolvePlanTier(req: Request): Promise<PlanId> {
  const raw = String((req as any).user?.planTier ?? "free");
  return normalizePlanId(raw);
}

export async function checkUsageGate(req: Request, res: Response, next: NextFunction) {
  const userId = Number((req as any).user?.userId ?? (req as any).user?.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const planTier = await resolvePlanTier(req);
  const gate = await checkUsage(userId, planTier, 0).catch(() => ({
    ok: true as const,
    reason: "ok" as const,
  }));

  if (!gate.ok) {
    return res.status(429).json({
      ok: false,
      error: "USAGE_CAP_EXCEEDED",
      reason: gate.reason,
      resetInSeconds: gate.resetInSeconds,
      capUsd: gate.capUsd,
      usedUsd: gate.usedUsd,
      planTier,
    });
  }

  return next();
}
