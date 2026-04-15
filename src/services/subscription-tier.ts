// src/services/subscription-tier.ts

import { type PlanId, PLAN_CONFIGS, normalizePlanId, getPlanPriority } from "yua-shared/plan/plan-pricing";

export const TIER_PRIORITY: Record<string, number> = Object.fromEntries(
  Object.entries(PLAN_CONFIGS).map(([k, v]) => [k, v.priority])
);

export function planToTier(plan: string): PlanId {
  return normalizePlanId(plan);
}
