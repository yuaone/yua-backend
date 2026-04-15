// src/connectors/oauth/providers/github.ts
// GitHub OAuth 2.0 provider spec.
//
// Register the OAuth app at: https://github.com/settings/developers
// Authorization callback URL: https://yuaone.com/api/connectors/github/callback

export const githubOAuth = {
  id: "github" as const,
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userInfoUrl: "https://api.github.com/user",
  scopes: ["repo", "read:user"],
  get clientId(): string {
    return (process.env.GITHUB_OAUTH_CLIENT_ID ?? "").trim();
  },
  get clientSecret(): string {
    return (process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "").trim();
  },
  get configured(): boolean {
    const id = this.clientId;
    const secret = this.clientSecret;
    return Boolean(
      id && secret && id !== "xx" && secret !== "xx",
    );
  },
};

export function buildGithubAuthorizeUrl(params: {
  state: string;
  challenge: string;
  redirectUri: string;
}): string {
  const u = new URL(githubOAuth.authorizeUrl);
  u.searchParams.set("client_id", githubOAuth.clientId);
  u.searchParams.set("scope", githubOAuth.scopes.join(" "));
  u.searchParams.set("state", params.state);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("code_challenge", params.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("allow_signup", "false");
  return u.toString();
}

export interface GithubTokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export async function exchangeGithubCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<GithubTokenResponse> {
  const body = new URLSearchParams({
    client_id: githubOAuth.clientId,
    client_secret: githubOAuth.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  });

  const res = await fetch(githubOAuth.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status}`);
  }
  return (await res.json()) as GithubTokenResponse;
}

export async function fetchGithubUser(
  accessToken: string,
): Promise<{ id: number; login: string } | null> {
  try {
    const res = await fetch(githubOAuth.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id: number; login: string };
    return { id: json.id, login: json.login };
  } catch {
    return null;
  }
}
