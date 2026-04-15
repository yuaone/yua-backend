// 📂 src/auth/jwt.ts
// 🔒 YUA 자체 JWT 토큰 발행/검증 — Firebase 대체

import jwt from "jsonwebtoken";
import crypto from "crypto";

const _secret = process.env.JWT_SECRET;
if (!_secret) throw new Error("FATAL: JWT_SECRET not set");
const JWT_SECRET: string = _secret;
const ACCESS_EXPIRES = "15m";
const REFRESH_BYTES = 32;

export interface JwtPayload {
  userId: number;
  email: string;
  role: string;
  tier: string;
}

/** Access Token 발행 (15분) */
export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_EXPIRES, algorithm: "HS256" });
}

/** Access Token 검증 */
export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as JwtPayload;
  } catch {
    return null;
  }
}

/** Refresh Token 생성 (랜덤 64자 hex) */
export function generateRefreshToken(): string {
  return crypto.randomBytes(REFRESH_BYTES).toString("hex");
}

/** Token → SHA-256 해시 (DB 저장용) */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
