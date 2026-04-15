// src/types/plan-map.ts
// DEPRECATED — use normalizePlanId() from plan-pricing SSOT

import { type PlanId, normalizePlanId } from "yua-shared/plan/plan-pricing";

export { normalizePlanId as planToNormalizedId };

/** @deprecated Use normalizePlanId() */
export const PLAN_MAP: Record<string, PlanId> = {
  free: "free",
  premium: "pro",
  developer: "pro",
  developer_pro: "pro",
  pro: "pro",
  business: "business",
  business_premium: "business",
  enterprise: "enterprise",
  enterprise_team: "enterprise",
  enterprise_developer: "enterprise",
  max: "max",
};
