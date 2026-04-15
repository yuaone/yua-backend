// 📂 src/auth/auth.express.ts
// Express Request → JWT / Firebase 검증 + PostgreSQL User Resolve
// ✔ SSOT: JWT 우선, Firebase fallback (마이그레이션 기간)
// ✔ express.d.ts User 확장과 100% 호환
// ✔ auth.server.ts에서 JWT/Firebase 자동 분기

import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { getUserFromRequest } from "./auth.server";
import {
  registerSession,
  touchSession,
  isRevoked,
  parseDeviceLabel,
} from "./session-registry";

/* ==================================================
   Internal Helper
================================================== */

/**
 * Express Request → Fetch-like Request Adapter
 * - authorization / Authorization / string[] 모두 대응
 * - auth.server.ts 무수정 보장
 */
function makeFetchLikeRequest(req: Request) {
  const rawAuth =
    (req.headers.authorization ??
      (req.headers as any).Authorization ??
      null) as string | string[] | null;

  const authHeader = Array.isArray(rawAuth)
    ? rawAuth[0]
    : typeof rawAuth === "string"
    ? rawAuth
    : null;

  // 🔍 DEBUG

  return {
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "authorization") {
          return authHeader;
        }
        return null;
      },
    },
  };
}

/* ==================================================
   Core Resolver
================================================== */

export async function resolveUserFromExpress(
  req: Request
): Promise<Express.User> {
  const fetchLikeReq = makeFetchLikeRequest(req);
  const user = await getUserFromRequest(fetchLikeReq as any);

  // 🔒 SSOT: Express.User.id === userId
  if ((user as any).id == null) {
    (user as any).id = user.userId;
  }

  return user as Express.User;
}

/* ==================================================
   Alias Export (기존 코드 호환)
================================================== */

export async function getUserFromExpressRequest(req: Request) {
  return resolveUserFromExpress(req);
}

/* ==================================================
   Session ID helper (Agent B3)
==================================================
 * Derive a stable-per-token session id from the raw Bearer token.
 *
 * Choice: SHA-256(token).slice(0,16).
 * - For YUA JWTs: token payload includes userId + iat/exp; the same token
 *   across requests yields the same hash → stable session id.
 * - For Firebase ID tokens: same token across requests yields same hash.
 *   A token refresh rotates the hash → creates a new `user_sessions` row.
 *   For MVP this is acceptable (each refresh == "new session").
 * - We intentionally do NOT decode jti here to avoid a second verify pass;
 *   the raw-token hash is opaque and stable for the token's lifetime.
 */
function computeSessionId(req: Request): string | null {
  const rawAuth =
    (req.headers.authorization ??
      (req.headers as any).Authorization ??
      null) as string | string[] | null;
  const header = Array.isArray(rawAuth)
    ? rawAuth[0]
    : typeof rawAuth === "string"
    ? rawAuth
    : null;
  if (!header) return null;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/* ==================================================
   Express Middleware
================================================== */

/** 인증 미들웨어 — JWT 우선, Firebase fallback */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const user = await getUserFromExpressRequest(req);
    req.user = user;

    // ---- Session registry side-effect (Agent B3) ----
    // Runs AFTER the user is authenticated. Touches are fire-and-forget,
    // but the revoke check is awaited because it must gate the request.
    try {
      const sessionId = computeSessionId(req);
      if (sessionId) {
        if (await isRevoked(sessionId)) {
          return res
            .status(401)
            .json({ ok: false, error: "SESSION_REVOKED" });
        }
        (req as any).sessionId = sessionId;

        const userAgent =
          (req.headers["user-agent"] as string | undefined) ?? undefined;
        const ipAddress = (req.ip as string | undefined) ?? undefined;

        // Fire-and-forget: upsert the session row (first-time register or last_seen bump).
        void registerSession({
          userId: (user as any).userId,
          sessionId,
          deviceLabel: parseDeviceLabel(userAgent),
          ipAddress,
          userAgent,
        }).catch(() => {});

        // Fire-and-forget: also bump last_seen_at explicitly (cheap no-op if
        // the register above already did it; keeps the semantic clean).
        void touchSession(sessionId).catch(() => {});
      }
    } catch (sessErr) {
      console.warn("[session-registry] middleware side-effect:", sessErr);
    }

    next();
  } catch (err: any) {
    console.error("[AUTH] middleware FAILED:", err?.message || err);
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Invalid or expired token",
    });
  }
}

/** 하위 호환 alias — 기존 코드에서 requireFirebaseAuth 사용 중 */
export const requireFirebaseAuth = requireAuth;
