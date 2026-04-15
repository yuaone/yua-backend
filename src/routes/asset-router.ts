import { Router } from "express";
import { assetController } from "../control/asset-controller";
import { validateAssetExecution } from "../api/middleware/validate-asset-execution";
import { requireAuthOrApiKey } from "../auth/auth-or-apikey";
import { withWorkspace } from "../middleware/with-workspace";

const router = Router();
router.use(requireAuthOrApiKey("yua"), withWorkspace);

/* --------------------------------------------------
 * Asset Pipeline
 * -------------------------------------------------- */

// Planner
router.post("/plan", assetController.plan);

// Judge
router.post("/judge", assetController.judge);

// Execute
// 🔥 여기만 validate 붙이면 끝
router.post(
  "/execute",
  validateAssetExecution,
  assetController.execute
);

export default router;
