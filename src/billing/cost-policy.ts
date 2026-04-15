// src/billing/cost-policy.ts

import { type PlanId, PLAN_CONFIGS } from "yua-shared/plan/plan-pricing";

export interface EngineCostTable {
  base: number;
  perToken?: number;
  perCycle?: number;
}

export const ENGINE_COST: Record<string, EngineCostTable> = {
  gen59:        { base: 0.3,  perToken: 0.0001 },
  hpe7:         { base: 1.0,  perToken: 0.00025 },
  "omega-lite": { base: 0.2 },
  stability:    { base: 0.05 },
  memory:       { base: 0.03 },
  "quantum-v2": { base: 5.0,  perCycle: 0.002 },
};

export function getTierMultiplier(plan: PlanId): number {
  return PLAN_CONFIGS[plan].multiplier;
}

/** @deprecated Use getTierMultiplier() */
export const TIER_MULTIPLIER: Record<string, number> = Object.fromEntries(
  Object.entries(PLAN_CONFIGS).map(([k, v]) => [k, v.multiplier])
);

export function engineCostEstimate(engines: string[], plan: PlanId): number {
  const multiplier = getTierMultiplier(plan);
  let total = 0;
  for (const e of engines) {
    const table = ENGINE_COST[e];
    if (!table) continue;
    total += table.base;
  }
  return Number((total * multiplier).toFixed(4));
}
