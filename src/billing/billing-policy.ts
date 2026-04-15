// src/billing/billing-policy.ts

import { type PlanId, PLAN_CONFIGS } from "yua-shared/plan/plan-pricing";

export interface BillingPolicy {
  maxDaily: number;
  maxMonthly: number;
  multiplier: number;
}

export function getBillingPolicy(plan: PlanId): BillingPolicy {
  const config = PLAN_CONFIGS[plan];
  return {
    maxDaily: config.chat.dailyMessages === 0 ? Infinity : config.chat.dailyMessages * 500,
    maxMonthly: config.chat.monthlyMessages === 0 ? Infinity : config.chat.monthlyMessages * 500,
    multiplier: config.multiplier,
  };
}

/** @deprecated Use getBillingPolicy() */
export const BILLING_POLICY: Record<string, BillingPolicy> = Object.fromEntries(
  Object.entries(PLAN_CONFIGS).map(([k, v]) => [
    k,
    {
      maxDaily: v.chat.dailyMessages === 0 ? Infinity : v.chat.dailyMessages * 500,
      maxMonthly: v.chat.monthlyMessages === 0 ? Infinity : v.chat.monthlyMessages * 500,
      multiplier: v.multiplier,
    },
  ])
);
