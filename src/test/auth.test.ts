// 📂 src/test/auth.test.ts
// bun test — auth 파이프라인 단위 테스트

import { describe, test, expect } from "bun:test";
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
} from "../auth/jwt.js";

describe("JWT", () => {
  const payload = {
    userId: 8,
    email: "dmsal020813@gmail.com",
    role: "admin",
    tier: "free",
  };

  test("signAccessToken → 유효한 JWT 발행", () => {
    const token = signAccessToken(payload);
    expect(token).toBeString();
    expect(token.split(".").length).toBe(3); // header.payload.sig
  });

  test("verifyAccessToken → 올바른 payload 반환", () => {
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe(8);
    expect(decoded!.email).toBe("dmsal020813@gmail.com");
    expect(decoded!.role).toBe("admin");
  });

  test("verifyAccessToken → 잘못된 토큰 null", () => {
    const result = verifyAccessToken("invalid.token.here");
    expect(result).toBeNull();
  });

  test("verifyAccessToken → 빈 문자열 null", () => {
    const result = verifyAccessToken("");
    expect(result).toBeNull();
  });

  test("generateRefreshToken → 64자 hex", () => {
    const token = generateRefreshToken();
    expect(token).toBeString();
    expect(token.length).toBe(64);
    expect(/^[a-f0-9]+$/.test(token)).toBe(true);
  });

  test("generateRefreshToken → 매번 다른 값", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
  });

  test("hashToken → SHA-256 hex", () => {
    const token = generateRefreshToken();
    const hash = hashToken(token);
    expect(hash).toBeString();
    expect(hash.length).toBe(64);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
  });

  test("hashToken → 같은 입력 같은 출력", () => {
    const token = "test-token";
    expect(hashToken(token)).toBe(hashToken(token));
  });

  test("hashToken → 다른 입력 다른 출력", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("Google OAuth", () => {
  test("verifyGoogleToken import 가능", async () => {
    const mod = await import("../auth/google-oauth.js");
    expect(typeof mod.verifyGoogleToken).toBe("function");
  });

  test("잘못된 토큰 → null", async () => {
    const { verifyGoogleToken } = await import("../auth/google-oauth.js");
    const result = await verifyGoogleToken("fake-token");
    expect(result).toBeNull();
  });
});
