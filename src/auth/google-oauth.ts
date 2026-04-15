// 📂 src/auth/google-oauth.ts
// 🔒 순수 Google OAuth — Firebase 없이 google-auth-library 직접 검증

import { OAuth2Client } from "google-auth-library";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) console.warn("[GOOGLE_OAUTH] GOOGLE_CLIENT_ID not set");

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

export interface GoogleUser {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  email_verified: boolean;
}

/**
 * Google ID Token 검증 (@react-oauth/google의 credential)
 * audience = GOOGLE_CLIENT_ID 일치해야 함
 */
export async function verifyGoogleToken(credential: string): Promise<GoogleUser | null> {
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) return null;

    return {
      sub: payload.sub,
      email: payload.email ?? "",
      name: payload.name ?? null,
      picture: payload.picture ?? null,
      email_verified: payload.email_verified ?? false,
    };
  } catch (e) {
    console.error("[GOOGLE_OAUTH][VERIFY_FAILED]", e);
    return null;
  }
}
