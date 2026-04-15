// src/middleware/require-paid-plan.ts
// 유료 플랜 필수 미들웨어 — free 유저 차단

import type { Request, Response, NextFunction } from "express";
import { WorkspacePlanService, type Tier } from "../ai/plan/workspace-plan.service";

const FREE_TIER: Tier = "free";

/**
 * 유료 플랜(pro 이상) 필수 미들웨어.
 * workspace tier가 free면 402 반환.
 *
 * 사용:
 *   router.use("/yuan-agent", requireAuthOrApiKey(), withWorkspace, requirePaidPlan(), handler);
 */
export function requirePaidPlan(minTier: Tier = "pro") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const workspaceId = req.workspace?.id;

    if (!workspaceId) {
      res.status(400).json({
        ok: false,
        error: "workspace_required",
        message: "Workspace context is required",
      });
      return;
    }

    const tier = await WorkspacePlanService.getTier(String(workspaceId));

    if (tier === FREE_TIER) {
      res.status(402).json({
        ok: false,
        error: "plan_required",
        message: `This feature requires ${minTier} plan or higher. Current: free`,
        tier,
        required_tier: minTier,
        upgrade_url: "/upgrade",
      });
      return;
    }

    // tier가 free가 아니면 통과 (pro/business/enterprise)
    req._workspaceTier = tier;
    next();
  };
}
