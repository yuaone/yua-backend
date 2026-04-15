// src/connectors/oauth/providers/google.ts
// Google OAuth 2.0 provider — shared by gdrive, gmail, google_calendar.
// Single OAuth app with scope-switching per provider.
//
// Google Cloud Console → APIs & Services → Credentials
// Authorized redirect URIs:
//   https://yuaone.com/api/connectors/gdrive/callback
//   https://yuaone.com/api/connectors/gmail/callback
//   https://yuaone.com/api/connectors/google_calendar/callback

const GOOGLE_SCOPES: Record<string, string[]> = {
  gdrive: ["https://www.googleapis.com/auth/drive.readonly"],
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  google_calendar: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ],
};

export const googleOAuth = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  get clientId(): string {
    return (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  },
  get clientSecret(): string {
    return (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  },
  get configured(): boolean {
    const id = this.clientId;
    const secret = this.clientSecret;
    return Boolean(id && secret && id !== "xx" && secret !== "xx");
  },
};

export function getGoogleScopes(provider: string): string[] {
  return GOOGLE_SCOPES[provider] ?? GOOGLE_SCOPES.gdrive;
}

export function isGoogleProvider(provider: string): boolean {
  return provider === "gdrive" || provider === "gmail" || provider === "google_calendar";
}

export function buildGoogleAuthorizeUrl(params: {
  provider: string;
  state: string;
  challenge: string;
  redirectUri: string;
}): string {
  const u = new URL(googleOAuth.authorizeUrl);
  u.searchParams.set("client_id", googleOAuth.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", getGoogleScopes(params.provider).join(" "));
  u.searchParams.set("state", params.state);
  u.searchParams.set("code_challenge", params.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export async function exchangeGoogleCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: googleOAuth.clientId,
    client_secret: googleOAuth.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.verifier,
  });

  const res = await fetch(googleOAuth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed: ${res.status} — ${text}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

export async function fetchGoogleUser(
  accessToken: string,
): Promise<{ email: string; name?: string } | null> {
  try {
    const res = await fetch(googleOAuth.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { email: string; name?: string };
    return { email: json.email, name: json.name };
  } catch {
    return null;
  }
}
