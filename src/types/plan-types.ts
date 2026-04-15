// src/types/plan-types.ts
// Re-exports from yua-shared SSOT

export {
  type PlanId,
  type PlanConfig,
  type ChatLimits,
  type AgentLimits,
  PLAN_CONFIGS,
  normalizePlanId,
  getPlanPrice,
  getPlanChatLimits,
  getPlanAgentLimits,
} from "yua-shared/plan/plan-pricing";

// Legacy aliases for backward compatibility
export type TierType = import("yua-shared/plan/plan-pricing").PlanId;
export type BillingPolicy = {
  maxDaily: number;
  maxMonthly: number;
  multiplier: number;
};
