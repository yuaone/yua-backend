// 📂 src/auth/auth-or-apikey.ts
// 🔐 JWT/Firebase OR x-api-key 인증 — scope 분리 (YUA / YUAN)
//
// API key scope:
//   'yua'  → 채팅 전용 (/v1/chat/completions 등)
//   'yuan' → 코딩 에이전트 전용 (/yuan-agent/* 등)
//
// JWT/Firebase 인증은 scope 제한 없음 (웹/앱 유저는 둘 다 접근 가능)

import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getUserFromExpressRequest } from "./auth.express";
import { verifyDeviceToken } from "./device-auth";
import { pgPool } from "../db/postgres";

export type ApiScope = "yua" | "yuan";

/**
 * Scope-aware 인증 미들웨어 팩토리.
 *
 * - Firebase / Device Token 인증 → scope 무관 (통과)
 * - API Key 인증 → key의 scope가 requiredScope와 일치해야 통과
 *
 * 사용:
 *   router.use("/v1", requireAuthOrApiKey("yua"), v1Router);
 *   router.use("/yuan-agent", requireAuthOrApiKey("yuan"), yuanRouter);
 *   router.use("/some-route", requireAuthOrApiKey(), someRouter);  // scope 체크 안 함
 */
export function requireAuthOrApiKey(requiredScope?: ApiScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    /* ======================================================
       1️⃣ Firebase 인증 (scope 제한 없음)
    ====================================================== */
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith("Bearer ")) {
      // Device token (ydt_ prefix)
      if (authHeader.startsWith("Bearer ydt_")) {
        const result = await verifyDeviceToken(authHeader.slice(7));
        if (result) {
          const { rows } = await pgPool.query(
            "SELECT id, email, name, role, firebase_uid FROM users WHERE id = $1 LIMIT 1",
            [result.userId],
          );
          const user = rows?.[0];
          if (user) {
            const uid = Number(user.id);
            req.user = {
              userId: uid,
              id: uid,
              firebaseUid: user.firebase_uid ?? `device:${uid}`,
              email: user.email ?? null,
              name: user.name ?? "Device Token User",
              role: user.role ?? "user",
            };
            req._apiKeyAuth = true;
            // Device tokens → scope 제한 없음 (모바일 앱)
            next();
            return;
          }
        }
        res.status(401).json({ ok: false, error: "invalid_device_token" });
        return;
      }

      // Firebase token
      try {
        const fbUser = await getUserFromExpressRequest(req);
        if (!fbUser) {
          res.status(401).json({ ok: false, error: "invalid_firebase_token" });
          return;
        }

        req.user = {
          userId: fbUser.userId,
          id: fbUser.userId,
          email: fbUser.email ?? null,
          firebaseUid: fbUser.firebaseUid,
          name: fbUser.name ?? "Firebase User",
          role: fbUser.role ?? "user",
        };
        // Firebase 인증 → scope 제한 없음
        next();
        return;
      } catch {
        res.status(401).json({ ok: false, error: "invalid_firebase_token" });
        return;
      }
    }

    /* ======================================================
       2️⃣ API Key 인증 — scope 검증
    ====================================================== */
    const apiKey =
      (req.headers["x-api-key"] as string | undefined)?.trim() ??
      (req.headers["x-api-key".toUpperCase()] as string | undefined)?.trim();

    if (!apiKey) {
      res.status(401).json({ ok: false, error: "authorization_required" });
      return;
    }

    const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

    try {
      /* ---------- PostgreSQL api_keys_v2 ---------- */
      const apiKeyResult = await pgPool.query(
        `SELECT ak.user_id, ak.scope, u.email, u.name
         FROM api_keys_v2 ak
         JOIN users u ON u.id = ak.user_id
         WHERE ak.key_hash = $1
         LIMIT 1`,
        [apiKeyHash]
      );

      const row = apiKeyResult.rows?.[0];
      if (row) {
        const keyScope: ApiScope = row.scope ?? "yua";

        // 🔒 Scope 검증: 라우트가 요구하는 scope와 키의 scope 비교
        if (requiredScope && keyScope !== requiredScope) {
          res.status(403).json({
            ok: false,
            error: "scope_mismatch",
            message: `This API key has scope "${keyScope}" but this endpoint requires "${requiredScope}"`,
          });
          return;
        }

        const userId = Number(row.user_id);
        req.user = {
          userId,
          id: userId,
          email: row.email ?? null,
          firebaseUid: "api_key",
          name: row.name ?? "API Key User",
          role: "user",
        };
        req._apiKeyAuth = true;
        req._apiKeyScope = keyScope;

        next();
        return;
      }

      /* ---------- PostgreSQL platform_api_keys ---------- */
      const pgResult = await pgPool.query(
        `SELECT id, workspace_id, user_id, name, status, scope
         FROM platform_api_keys
         WHERE key_hash = $1
           AND status = 'active'
         LIMIT 1`,
        [apiKeyHash]
      );

      const platformKey = pgResult.rows?.[0];
      if (!platformKey) {
        res.status(401).json({ ok: false, error: "invalid_api_key" });
        return;
      }

      const platformKeyScope: ApiScope = platformKey.scope ?? "yua";

      // 🔒 Scope 검증
      if (requiredScope && platformKeyScope !== requiredScope) {
        res.status(403).json({
          ok: false,
          error: "scope_mismatch",
          message: `This API key has scope "${platformKeyScope}" but this endpoint requires "${requiredScope}"`,
        });
        return;
      }

      const platformUserId = Number(platformKey.user_id);
      const platformWorkspaceId = String(platformKey.workspace_id); // UUID

      let userEmail: string | null = null;
      let userName: string = "Platform API Key User";
      try {
        const userResult = await pgPool.query(
          `SELECT email, name FROM users WHERE id = $1 LIMIT 1`,
          [platformUserId]
        );
        if (userResult.rows?.[0]) {
          userEmail = userResult.rows[0].email ?? null;
          userName = userResult.rows[0].name ?? "Platform API Key User";
        }
      } catch (userErr) {
        console.warn("[AUTH][PLATFORM_KEY] Failed to look up user info:", userErr);
      }

      req.user = {
        userId: platformUserId,
        id: platformUserId,
        email: userEmail,
        firebaseUid: "platform_api_key",
        name: userName,
        role: "user",
      };
      req._apiKeyAuth = true;
      req._apiKeyScope = platformKeyScope;

      req.headers["x-workspace-id"] = String(platformWorkspaceId);

      // Fire-and-forget: update last_used_at
      pgPool
        .query(
          `UPDATE platform_api_keys SET last_used_at = NOW() WHERE id = $1`,
          [platformKey.id]
        )
        .catch((e: any) =>
          console.warn("[AUTH][PLATFORM_KEY] Failed to update last_used_at:", e)
        );

      next();
      return;
    } catch (err) {
      console.error("[AUTH][API_KEY]", err);
      res.status(500).json({ ok: false, error: "api_key_auth_failed" });
      return;
    }
  };
}
