import { Router } from "express";

const router = Router();

// Deprecated endpoint kept for backward compatibility.
// Canonical payload lives at GET /api/usage/detailed.
router.get("/status", (_req, res) => {
  return res.redirect(307, "/api/usage/detailed");
});

export default router;
