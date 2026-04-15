// src/connectors/oauth/pkce.ts
// OAuth 2.1 PKCE (Proof Key for Code Exchange) — required for public clients
// per RFC 7636 and mandated by MCP November 2025 auth spec.
//
// verifier:  43~128 char random URL-safe string
// challenge: base64url( SHA-256( verifier ) )

import crypto from "crypto";

export function generateVerifier(): string {
  // 32 random bytes → ~43 base64url chars (well within the 43-128 range)
  return crypto.randomBytes(32).toString("base64url");
}

export function computeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  // 24 random bytes → 48 hex chars (192 bits). Used as CSRF nonce + Redis
  // lookup key. 192 bits is well beyond the birthday-collision threshold
  // even at millions of concurrent flows, so state-hijack via collision is
  // cryptographically out of reach.
  return crypto.randomBytes(24).toString("hex");
}
