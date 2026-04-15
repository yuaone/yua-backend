// src/routes/auth-device-router.ts
// CLI/Desktop device login flow

import { Router, Request, Response } from "express";
import { requireFirebaseAuth } from "../auth/auth.express";
import { issueDeviceToken, listDeviceTokens, revokeDeviceToken } from "../auth/device-auth";

const router = Router();

/** POST /auth/device/issue — Issue a device token (requires Firebase auth) */
router.post("/issue", requireFirebaseAuth, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const { device_name, client_type } = req.body;
  if (!client_type || !["cli", "desktop", "sdk"].includes(client_type)) {
    return res.status(400).json({ error: "client_type must be cli, desktop, or sdk" });
  }

  const token = await issueDeviceToken(userId, device_name ?? "Unknown Device", client_type);
  return res.json({ ok: true, token, message: "Save this token — it won't be shown again" });
});

/** GET /auth/device/list — List active tokens */
router.get("/list", requireFirebaseAuth, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const tokens = await listDeviceTokens(userId);
  return res.json({ ok: true, tokens });
});

/** POST /auth/device/revoke — Revoke a token by ID */
router.post("/revoke", requireFirebaseAuth, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  const { token_id } = req.body;
  if (!token_id) return res.status(400).json({ error: "token_id required" });
  const ok = await revokeDeviceToken(token_id, userId);
  return res.json({ ok });
});

export default router;
