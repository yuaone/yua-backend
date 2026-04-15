/**
 * YUAN Auth Router — OAuth Device Flow for YUAN CLI
 *
 * Endpoints:
 *   POST /device-code    — Generate device + user code (public)
 *   POST /device-token   — Poll for token after user confirms (public)
 *   POST /device-confirm — User confirms device code (Firebase auth required)
 *   POST /refresh        — Refresh access token (public)
 *   GET  /verify         — Verify CLI token / API key (auth required)
 *
 * Mount: router.use("/yuan-auth", yuanAuthRouter);
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { pgPool } from "../db/postgres";
import { mysqlPool } from "../db/mysql";
import { requireFirebaseAuth, resolveUserFromExpress } from "../auth/auth.express";

const router = Router();

/* ──────────────────────────────────────────
   Constants
────────────────────────────────────────── */

const JWT_SECRET = process.env.JWT_SECRET || "yuan-dev-secret";
const ACCESS_TOKEN_EXPIRY = "1h";
const REFRESH_TOKEN_EXPIRY = "30d";
const DEVICE_CODE_TTL_SECONDS = 900; // 15 minutes
const POLL_INTERVAL_SECONDS = 5;

/* ──────────────────────────────────────────
   Rate Limit State (in-memory, per-process)
────────────────────────────────────────── */

interface RateBucket {
  count: number;
  resetAt: number;
}

const deviceCodeLimits = new Map<string, RateBucket>(); // IP -> bucket
const deviceTokenLimits = new Map<string, RateBucket>(); // deviceCode -> bucket

function checkRateLimit(
  map: Map<string, RateBucket>,
  key: string,
  maxPerMinute: number
): boolean {
  const now = Date.now();
  const bucket = map.get(key);

  if (!bucket || now > bucket.resetAt) {
    map.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (bucket.count >= maxPerMinute) {
    return false;
  }

  bucket.count++;
  return true;
}

// Periodic cleanup of stale rate limit entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of deviceCodeLimits) {
    if (now > bucket.resetAt) deviceCodeLimits.delete(key);
  }
  for (const [key, bucket] of deviceTokenLimits) {
    if (now > bucket.resetAt) deviceTokenLimits.delete(key);
  }
}, 5 * 60_000);

/* ──────────────────────────────────────────
   Helpers
────────────────────────────────────────── */

function getUserId(req: any): number | null {
  const raw = req.user?.userId ?? req.user?.id;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function generateUserCode(): string {
  return "YUAN-" + crypto.randomBytes(2).toString("hex").toUpperCase().slice(0, 4);
}

function signAccessToken(userId: number, email: string | null): string {
  return jwt.sign(
    { userId, email, type: "yuan-cli" },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

function signRefreshToken(userId: number, email: string | null): string {
  return jwt.sign(
    { userId, email, type: "yuan-refresh" },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

async function cleanupExpiredCodes(): Promise<void> {
  try {
    await pgPool.query(
      `UPDATE device_auth_codes
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at < NOW()`
    );
  } catch (err: any) {
    console.warn("[yuan-auth] cleanup expired codes error:", err.message);
  }
}

/**
 * Look up user info from MySQL users table.
 * Returns { email, name, plan } or null.
 */
async function lookupUser(userId: number): Promise<{
  email: string | null;
  name: string | null;
  plan: string | null;
} | null> {
  try {
    const [rows]: any = await mysqlPool.query(
      `SELECT email, name, plan FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    if (rows?.[0]) {
      return {
        email: rows[0].email ?? null,
        name: rows[0].name ?? null,
        plan: rows[0].plan ?? "free",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get or create a platform API key for the user.
 * Returns the raw key string (yua_sk_...).
 */
async function getOrCreateApiKey(userId: number): Promise<string> {
  // Check if user already has an active platform API key
  const existing = await pgPool.query(
    `SELECT id, key_prefix FROM platform_api_keys
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );

  if (existing.rows.length > 0) {
    // User already has a key — we can't return the raw key (it's hashed).
    // Generate a new one specifically for CLI use.
  }

  // Generate a new API key for CLI
  const rawKey = `yua_sk_${crypto.randomBytes(24).toString("hex")}`;
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  // Find or create a workspace for the user
  let workspaceId = 1; // fallback
  try {
    const wsResult = await pgPool.query(
      `SELECT id FROM workspaces
       WHERE owner_id = $1
       ORDER BY created_at ASC LIMIT 1`,
      [userId]
    );
    if (wsResult.rows.length > 0) {
      workspaceId = wsResult.rows[0].id;
    }
  } catch {
    // Use fallback workspace ID
  }

  await pgPool.query(
    `INSERT INTO platform_api_keys (workspace_id, user_id, name, key_prefix, key_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [workspaceId, userId, "YUAN CLI (auto-generated)", keyPrefix, keyHash]
  );

  return rawKey;
}

/**
 * Build plan info for a user (based on their plan field).
 */
function buildPlanInfo(plan: string | null): {
  name: string;
  maxIterations: number;
  maxParallel: number;
  dailyRuns: number;
} {
  const p = plan ?? "free";
  switch (p) {
    case "premium":
      return { name: "premium", maxIterations: 50, maxParallel: 3, dailyRuns: 100 };
    case "developer":
      return { name: "developer", maxIterations: 100, maxParallel: 5, dailyRuns: 500 };
    case "developer_pro":
      return { name: "developer_pro", maxIterations: 200, maxParallel: 10, dailyRuns: 1000 };
    case "business":
    case "business_premium":
      return { name: p, maxIterations: 200, maxParallel: 10, dailyRuns: 2000 };
    case "enterprise":
    case "enterprise_team":
    case "enterprise_developer":
      return { name: p, maxIterations: 500, maxParallel: 20, dailyRuns: 10000 };
    default:
      return { name: "free", maxIterations: 10, maxParallel: 1, dailyRuns: 20 };
  }
}

/* ──────────────────────────────────────────
   1. POST /device-code — Generate device code (no auth)
────────────────────────────────────────── */
router.post("/device-code", async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(deviceCodeLimits, ip, 5)) {
      return res.status(429).json({ error: "rate_limit_exceeded", message: "Max 5 requests per minute" });
    }

    // Cleanup expired codes on each request
    await cleanupExpiredCodes();

    const clientId = req.body?.clientId || "yuan-cli";
    if (typeof clientId !== "string" || clientId.length > 50) {
      return res.status(400).json({ error: "invalid_client_id" });
    }

    const deviceCode = crypto.randomBytes(32).toString("hex");

    // Generate unique user code with retry
    let userCode = generateUserCode();
    let retries = 0;
    while (retries < 5) {
      const existing = await pgPool.query(
        `SELECT id FROM device_auth_codes WHERE user_code = $1 AND status = 'pending'`,
        [userCode]
      );
      if (existing.rows.length === 0) break;
      userCode = generateUserCode();
      retries++;
    }

    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);

    await pgPool.query(
      `INSERT INTO device_auth_codes (device_code, user_code, client_id, status, expires_at)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [deviceCode, userCode, clientId, expiresAt.toISOString()]
    );

    return res.json({
      deviceCode,
      userCode,
      verificationUri: "https://platform.yuaone.com/cli-auth",
      expiresIn: DEVICE_CODE_TTL_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    });
  } catch (err: any) {
    console.error("[yuan-auth] POST /device-code error:", err.message);
    return res.status(500).json({ error: "internal_error", message: "Failed to generate device code" });
  }
});

/* ──────────────────────────────────────────
   2. POST /device-token — Poll for token (no auth)
────────────────────────────────────────── */
router.post("/device-token", async (req: Request, res: Response) => {
  try {
    const { deviceCode } = req.body || {};
    if (!deviceCode || typeof deviceCode !== "string" || deviceCode.length !== 64) {
      return res.status(400).json({ error: "invalid_request", message: "deviceCode is required (64 hex chars)" });
    }

    if (!checkRateLimit(deviceTokenLimits, deviceCode, 12)) {
      return res.status(429).json({ error: "slow_down", message: "Polling too fast, wait 5 seconds" });
    }

    // Cleanup expired codes
    await cleanupExpiredCodes();

    const result = await pgPool.query(
      `SELECT id, device_code, user_code, client_id, user_id, status, scopes, expires_at
       FROM device_auth_codes
       WHERE device_code = $1`,
      [deviceCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "invalid_device_code" });
    }

    const row = result.rows[0];

    // Check expiry
    if (new Date(row.expires_at) < new Date()) {
      if (row.status === "pending") {
        await pgPool.query(
          `UPDATE device_auth_codes SET status = 'expired' WHERE id = $1`,
          [row.id]
        );
      }
      return res.status(410).json({ error: "expired_token" });
    }

    switch (row.status) {
      case "pending":
        return res.status(428).json({ error: "authorization_pending" });

      case "expired":
        return res.status(410).json({ error: "expired_token" });

      case "used":
        return res.status(400).json({ error: "token_already_used" });

      case "confirmed": {
        const userId = Number(row.user_id);

        // Mark as used (single use)
        await pgPool.query(
          `UPDATE device_auth_codes SET status = 'used' WHERE id = $1`,
          [row.id]
        );

        // Look up user info
        const userInfo = await lookupUser(userId);
        const email = userInfo?.email ?? null;
        const name = userInfo?.name ?? null;
        const plan = userInfo?.plan ?? "free";

        // Generate tokens
        const accessToken = signAccessToken(userId, email);
        const refreshToken = signRefreshToken(userId, email);

        // Get or create API key
        const apiKey = await getOrCreateApiKey(userId);

        return res.json({
          accessToken,
          refreshToken,
          expiresIn: 3600,
          user: { id: userId, email, name },
          plan: buildPlanInfo(plan),
          apiKey,
        });
      }

      default:
        return res.status(400).json({ error: "invalid_status" });
    }
  } catch (err: any) {
    console.error("[yuan-auth] POST /device-token error:", err.message);
    return res.status(500).json({ error: "internal_error", message: "Failed to check device token" });
  }
});

/* ──────────────────────────────────────────
   3. POST /device-confirm — Confirm device code (Firebase auth)
────────────────────────────────────────── */
router.post("/device-confirm", requireFirebaseAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { userCode } = req.body || {};
    if (!userCode || typeof userCode !== "string") {
      return res.status(400).json({ ok: false, error: "userCode is required" });
    }

    // Normalize: uppercase, trim
    const normalizedCode = userCode.trim().toUpperCase();
    if (!/^YUAN-[A-Z0-9]{4}$/.test(normalizedCode)) {
      return res.status(400).json({ ok: false, error: "Invalid user code format. Expected: YUAN-XXXX" });
    }

    const result = await pgPool.query(
      `SELECT id, client_id, status, expires_at
       FROM device_auth_codes
       WHERE user_code = $1`,
      [normalizedCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Code not found" });
    }

    const row = result.rows[0];

    // Check expiry
    if (new Date(row.expires_at) < new Date()) {
      await pgPool.query(
        `UPDATE device_auth_codes SET status = 'expired' WHERE id = $1`,
        [row.id]
      );
      return res.status(410).json({ ok: false, error: "Code has expired" });
    }

    if (row.status !== "pending") {
      return res.status(400).json({ ok: false, error: `Code is already ${row.status}` });
    }

    // Confirm: set user_id and status
    await pgPool.query(
      `UPDATE device_auth_codes
       SET user_id = $1, status = 'confirmed', confirmed_at = NOW()
       WHERE id = $2`,
      [userId, row.id]
    );

    return res.json({ ok: true, clientId: row.client_id });
  } catch (err: any) {
    console.error("[yuan-auth] POST /device-confirm error:", err.message);
    return res.status(500).json({ ok: false, error: "Failed to confirm device code" });
  }
});

/* ──────────────────────────────────────────
   4. POST /refresh — Refresh access token (no auth)
────────────────────────────────────────── */
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken || typeof refreshToken !== "string") {
      return res.status(400).json({ error: "refreshToken is required" });
    }

    let payload: any;
    try {
      payload = jwt.verify(refreshToken, JWT_SECRET);
    } catch (jwtErr: any) {
      if (jwtErr.name === "TokenExpiredError") {
        return res.status(401).json({ error: "refresh_token_expired" });
      }
      return res.status(401).json({ error: "invalid_refresh_token" });
    }

    if (payload.type !== "yuan-refresh") {
      return res.status(401).json({ error: "invalid_token_type" });
    }

    const userId = Number(payload.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ error: "invalid_token_payload" });
    }

    // Issue new access token
    const accessToken = signAccessToken(userId, payload.email ?? null);

    return res.json({
      accessToken,
      expiresIn: 3600,
    });
  } catch (err: any) {
    console.error("[yuan-auth] POST /refresh error:", err.message);
    return res.status(500).json({ error: "internal_error", message: "Failed to refresh token" });
  }
});

/* ──────────────────────────────────────────
   5. GET /verify — Verify CLI token or API key
────────────────────────────────────────── */
router.get("/verify", async (req: Request, res: Response) => {
  try {
    /* ── Try JWT Bearer token first ── */
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();

      let payload: any;
      try {
        payload = jwt.verify(token, JWT_SECRET);
      } catch (jwtErr: any) {
        if (jwtErr.name === "TokenExpiredError") {
          return res.status(401).json({ ok: false, error: "token_expired" });
        }
        // Fall through to try Firebase auth
      }

      if (payload && payload.type === "yuan-cli") {
        const userId = Number(payload.userId);
        const userInfo = await lookupUser(userId);

        return res.json({
          ok: true,
          user: {
            id: userId,
            email: userInfo?.email ?? payload.email ?? null,
            name: userInfo?.name ?? null,
          },
          plan: buildPlanInfo(userInfo?.plan ?? null),
        });
      }
    }

    /* ── Try x-api-key (yua_sk_...) ── */
    const apiKey = (req.headers["x-api-key"] as string | undefined)?.trim();
    if (apiKey?.startsWith("yua_sk_")) {
      const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

      const keyResult = await pgPool.query(
        `SELECT user_id FROM platform_api_keys
         WHERE key_hash = $1 AND status = 'active'
         LIMIT 1`,
        [keyHash]
      );

      if (keyResult.rows.length === 0) {
        return res.status(401).json({ ok: false, error: "invalid_api_key" });
      }

      const userId = Number(keyResult.rows[0].user_id);
      const userInfo = await lookupUser(userId);

      // Update last_used_at (fire-and-forget)
      pgPool
        .query(`UPDATE platform_api_keys SET last_used_at = NOW() WHERE key_hash = $1`, [keyHash])
        .catch(() => {});

      return res.json({
        ok: true,
        user: {
          id: userId,
          email: userInfo?.email ?? null,
          name: userInfo?.name ?? null,
        },
        plan: buildPlanInfo(userInfo?.plan ?? null),
      });
    }

    /* ── Try Firebase auth as fallback ── */
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const fbUser = await resolveUserFromExpress(req);

        if (fbUser) {
          const userInfo = await lookupUser(fbUser.userId);
          return res.json({
            ok: true,
            user: {
              id: fbUser.userId,
              email: fbUser.email ?? null,
              name: fbUser.name ?? null,
            },
            plan: buildPlanInfo(userInfo?.plan ?? null),
          });
        }
      } catch {
        // Fall through
      }
    }

    return res.status(401).json({ ok: false, error: "unauthorized" });
  } catch (err: any) {
    console.error("[yuan-auth] GET /verify error:", err.message);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
