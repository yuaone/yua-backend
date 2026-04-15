// 📂 src/auth/auth.server.ts
// 🔒 YUA Auth SSOT — 자체 JWT 우선 + Firebase 호환 (마이그레이션 기간)

import { pgPool } from "../db/postgres";
import { verifyAccessToken, type JwtPayload } from "./jwt";

// Firebase fallback (마이그레이션 기간만 유지, 추후 제거)
let firebaseAuth: any = null;
try {
  const fb = require("../db/firebase");
  firebaseAuth = fb.auth;
} catch {
  console.warn("[AUTH] Firebase not available — JWT-only mode");
}

/* ======================================================
   Types (SSOT)
====================================================== */

export type ResolvedUser = {
  userId: number;
  id: number; // ✅ alias
  firebaseUid: string; // 호환용 — JWT에서는 "jwt:<userId>"
  email: string | null;
  name: string | null;
  role?: string;
  authProvider?: "google" | "apple" | "email" | null;
};

/* ======================================================
   SSOT ENTRY POINT — JWT 우선, Firebase fallback
====================================================== */

export async function getUserFromRequest(
  req: { headers: { get(name: string): string | null } }
): Promise<ResolvedUser> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) throw new Error("Missing Authorization header");

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Empty Authorization token");

  // 1️⃣ 자체 JWT 시도 (우선)
  const jwtPayload = verifyAccessToken(token);
  if (jwtPayload) {
    return resolveUserFromJwt(jwtPayload);
  }

  // 2️⃣ Firebase fallback (마이그레이션 기간)
  if (firebaseAuth) {
    return resolveUserFromFirebase(token);
  }

  throw new Error("Invalid token — neither JWT nor Firebase");
}

/* ======================================================
   JWT → PostgreSQL User
====================================================== */

async function resolveUserFromJwt(payload: JwtPayload): Promise<ResolvedUser> {
  const { rows } = await pgPool.query<{
    id: number; email: string; name: string | null; role: string; auth_provider: string | null;
  }>(
    `SELECT id, email, name, role, auth_provider FROM users WHERE id = $1 LIMIT 1`,
    [payload.userId]
  );

  if (rows.length === 0) {
    throw new Error(`User not found: ${payload.userId}`);
  }

  const user = rows[0];
  const uid = Number(user.id);
  return {
    userId: uid,
    id: uid,
    firebaseUid: `jwt:${user.id}`, // 호환용
    email: user.email,
    name: user.name,
    role: user.role,
    authProvider: user.auth_provider as ResolvedUser["authProvider"],
  };
}

/* ======================================================
   Firebase → PostgreSQL User (마이그레이션 기간)
====================================================== */

async function resolveUserFromFirebase(idToken: string): Promise<ResolvedUser> {
  const decoded = await firebaseAuth.verifyIdToken(idToken, true);

  const firebaseUid = decoded.uid;
  if (!firebaseUid) throw new Error("Missing firebase uid");

  const email =
    decoded.email && decoded.email.length > 0
      ? decoded.email
      : `${firebaseUid}@user.local`;

  const decodedName =
    typeof decoded.name === "string" && decoded.name.length > 0
      ? decoded.name
      : null;

  const signInProvider =
    typeof (decoded as any)?.firebase?.sign_in_provider === "string"
      ? (decoded as any).firebase.sign_in_provider
      : null;
  const authProvider =
    signInProvider === "google.com"
      ? "google"
      : signInProvider === "password"
      ? "email"
      : null;

  // PostgreSQL 조회 (MySQL 제거)
  const { rows } = await pgPool.query<{
    id: number; email: string; name: string | null; role: string;
  }>(
    `SELECT id, email, name, role FROM users WHERE firebase_uid = $1 LIMIT 1`,
    [firebaseUid]
  );

  if (rows.length > 0) {
    const user = rows[0];
    const uid = Number(user.id);
    return {
      userId: uid,
      id: uid,
      firebaseUid,
      email: user.email ?? email,
      name: user.name ?? decodedName,
      role: user.role ?? undefined,
      authProvider,
    };
  }

  // 신규 유저 자동 생성
  const { rows: newRows } = await pgPool.query<{ id: number }>(
    `INSERT INTO users (firebase_uid, email, name, tier, role)
     VALUES ($1, $2, $3, 'free', 'user')
     RETURNING id`,
    [firebaseUid, email, decodedName]
  );

  const newUid = Number(newRows[0].id);
  return {
    userId: newUid,
    id: newUid,
    firebaseUid,
    email,
    name: decodedName,
    role: "user",
    authProvider,
  };
}
