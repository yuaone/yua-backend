// 📂 src/routes/auth-router.ts
// 🔒 YUA 자체 인증 API — Firebase 호환 + 자체 JWT + httpOnly cookie

import { Router } from "express";
import { pgPool } from "../db/postgres";
import { verifyGoogleToken } from "../auth/google-oauth";
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
} from "../auth/jwt";
import { AuthSessionRepo } from "../db/repo/auth-session.repo";
import { sendMagicLink, verifyMagicCode } from "../services/magic-link.service";

// Firebase fallback (마이그레이션 기간)
let firebaseAuth: any = null;
try {
  firebaseAuth = require("../db/firebase").auth;
} catch {}

const router = Router();

const REFRESH_COOKIE = "yua_rt";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7일
};

/* =========================
   POST /auth/google — Google OAuth → JWT
========================= */
router.post("/google", async (req, res) => {
  try {
    const credential = req.body.credential ?? req.body.idToken; // 호환: credential 우선, idToken fallback
    if (!credential) {
      return res.status(400).json({ ok: false, error: "missing_credential" });
    }

    const googleUser = await verifyGoogleToken(credential);
    if (!googleUser) {
      return res.status(401).json({ ok: false, error: "invalid_google_token" });
    }
    if (!googleUser.email_verified) {
      return res.status(403).json({ ok: false, error: "email_not_verified" });
    }

    const { user, isNew } = await findOrCreateUser({
      email: googleUser.email,
      name: googleUser.name,
      authProvider: "google",
      oauthUid: googleUser.sub,
      avatarUrl: googleUser.picture,
    });

    const { accessToken, refreshToken } = await issueTokens(user, req);

    res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
    return res.json({
      ok: true,
      accessToken,
      user: formatUser(user),
      isNew,
    });
  } catch (e: any) {
    console.error("[AUTH][GOOGLE]", e);
    return res.status(500).json({ ok: false, error: "auth_failed" });
  }
});

/* =========================
   POST /auth/login — Firebase idToken → JWT (마이그레이션 호환)
========================= */
router.post("/login", async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ ok: false, error: "missing_token" });
    }

    // Firebase 검증
    if (!firebaseAuth) {
      return res.status(501).json({ ok: false, error: "firebase_not_available" });
    }

    const decoded = await firebaseAuth.verifyIdToken(idToken);
    const firebaseUid = decoded.uid;
    const email = decoded.email ?? `${firebaseUid}@user.local`;
    const name = decoded.name ?? null;

    // PostgreSQL 유저 조회/생성
    const { rows } = await pgPool.query(
      `SELECT id, email, name, role, tier, avatar_url FROM users WHERE firebase_uid = $1 LIMIT 1`,
      [firebaseUid]
    );

    let user: UserRow;
    if (rows.length > 0) {
      user = { ...rows[0], id: Number(rows[0].id) };
    } else {
      const { rows: newRows } = await pgPool.query(
        `INSERT INTO users (firebase_uid, email, name, tier, role)
         VALUES ($1, $2, $3, 'free', 'user')
         RETURNING id, email, name, role, tier, avatar_url`,
        [firebaseUid, email, name]
      );
      user = { ...newRows[0], id: Number(newRows[0].id) };
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);

    res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
    return res.json({
      ok: true,
      accessToken,
      token: accessToken, // 하위 호환 (기존 프론트 `token` 필드 사용)
      user: formatUser(user),
    });
  } catch (e: any) {
    console.error("[AUTH][LOGIN]", e);
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
});

/* =========================
   POST /auth/refresh — Refresh Token → 새 Access Token (rotation)
========================= */
router.post("/refresh", async (req, res) => {
  try {
    const rt = req.cookies?.[REFRESH_COOKIE];
    if (!rt) {
      return res.status(401).json({ ok: false, error: "no_refresh_token" });
    }

    const oldHash = hashToken(rt);
    const session = await AuthSessionRepo.findByTokenHash(oldHash);
    if (!session) {
      res.clearCookie(REFRESH_COOKIE, { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" });
      return res.status(401).json({ ok: false, error: "invalid_session" });
    }

    const { rows } = await pgPool.query(
      `SELECT id, email, name, role, tier, avatar_url FROM users WHERE id = $1`,
      [session.user_id]
    );
    const user = rows[0];
    if (!user) {
      res.clearCookie(REFRESH_COOKIE, { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" });
      return res.status(401).json({ ok: false, error: "user_not_found" });
    }
    user.id = Number(user.id);

    // Token Rotation
    const newRt = generateRefreshToken();
    await AuthSessionRepo.rotate(
      oldHash, hashToken(newRt), user.id,
      { ua: req.headers["user-agent"], ip: req.ip }
    );

    const accessToken = signAccessToken({
      userId: user.id, email: user.email, role: user.role, tier: user.tier,
    });

    res.cookie(REFRESH_COOKIE, newRt, COOKIE_OPTS);
    return res.json({ ok: true, accessToken, user: formatUser(user) });
  } catch (e: any) {
    console.error("[AUTH][REFRESH]", e);
    return res.status(500).json({ ok: false, error: "refresh_failed" });
  }
});

/* =========================
   POST /auth/logout — 세션 삭제 + cookie 제거
========================= */
router.post("/logout", async (_req, res) => {
  try {
    const rt = _req.cookies?.[REFRESH_COOKIE];
    if (rt) {
      await AuthSessionRepo.deleteByTokenHash(hashToken(rt)).catch(() => {});
    }
    res.clearCookie(REFRESH_COOKIE, { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" });
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[AUTH][LOGOUT]", e);
    return res.json({ ok: true }); // 로그아웃은 항상 성공
  }
});

/* =========================
   POST /auth/email — 매직링크 코드 발송
========================= */
router.post("/email", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ ok: false, error: "missing_email" });
    }

    const result = await sendMagicLink(email);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.json({ ok: true, message: "code_sent" });
  } catch (e: any) {
    console.error("[AUTH][EMAIL]", e);
    return res.status(500).json({ ok: false, error: "email_failed" });
  }
});

/* =========================
   POST /auth/verify-code — 매직링크 코드 검증 → JWT 발급
========================= */
router.post("/verify-code", async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const result = await verifyMagicCode(email, code);
    if (!result.ok) {
      return res.status(401).json({ ok: false, error: result.error });
    }

    // 유저 조회/생성
    const { user, isNew } = await findOrCreateUser({
      email,
      name: email.split("@")[0],
      authProvider: "email",
      oauthUid: "",
      avatarUrl: null,
    });

    // JWT + cookie 발급
    const { accessToken, refreshToken } = await issueTokens(user, req);

    res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
    return res.json({
      ok: true,
      accessToken,
      user: formatUser(user),
      isNew,
    });
  } catch (e: any) {
    console.error("[AUTH][VERIFY_CODE]", e);
    return res.status(500).json({ ok: false, error: "verification_failed" });
  }
});

/* =========================
   GET /auth/me — Access Token → 유저 정보
========================= */
router.get("/me", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    const token = auth?.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return res.status(401).json({ ok: false, error: "missing_token" });
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
      return res.status(401).json({ ok: false, error: "invalid_token" });
    }

    const { rows } = await pgPool.query(
      `SELECT id, email, name, role, tier, avatar_url FROM users WHERE id = $1`,
      [payload.userId]
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }
    user.id = Number(user.id);

    return res.json({ ok: true, user: formatUser(user) });
  } catch (e: any) {
    console.error("[AUTH][ME]", e);
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
});

/* =========================
   Helpers
========================= */

interface UserRow {
  id: number;
  email: string;
  name: string | null;
  role: string;
  tier: string;
  avatar_url: string | null;
}

function formatUser(user: UserRow) {
  return {
    id: String(user.id),
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    tier: user.tier,
    role: user.role,
  };
}

async function findOrCreateUser(params: {
  email: string;
  name: string | null;
  authProvider: string;
  oauthUid: string;
  avatarUrl: string | null;
}): Promise<{ user: UserRow; isNew: boolean }> {
  // 🔒 Upsert — race condition 방지 (동시 요청 시 중복 생성 차단)
  const { rows } = await pgPool.query<UserRow & { _created: boolean }>(
    `INSERT INTO users (email, name, auth_provider, oauth_uid, avatar_url, tier, role)
     VALUES ($1, $2, $3, $4, $5, 'free', 'user')
     ON CONFLICT (email) DO UPDATE SET
       oauth_uid = COALESCE(users.oauth_uid, EXCLUDED.oauth_uid),
       avatar_url = COALESCE(users.avatar_url, EXCLUDED.avatar_url),
       updated_at = NOW()
     RETURNING id, email, name, role, tier, avatar_url,
       (xmax = 0) AS _created`,
    [params.email, params.name, params.authProvider, params.oauthUid, params.avatarUrl]
  );

  const user = { ...rows[0], id: Number(rows[0].id) };
  const isNew = (rows[0] as any)._created === true;
  return { user, isNew };
}

async function issueTokens(user: UserRow, req: any) {
  const accessToken = signAccessToken({
    userId: user.id, email: user.email, role: user.role, tier: user.tier,
  });
  const refreshToken = generateRefreshToken();
  await AuthSessionRepo.create(
    user.id, hashToken(refreshToken),
    { ua: req.headers?.["user-agent"], ip: req.ip }
  );
  return { accessToken, refreshToken };
}

export default router;
