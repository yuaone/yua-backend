// src/routes/connectors-oauth-router.ts
// OAuth 2.1 + PKCE authorize + callback endpoints for Phase 2 connector
// activation. Public callback path (provider redirect) — all state
// validation happens server-side against Redis.

import { Router, type Request, type Response } from "express";
import { generateVerifier, computeChallenge, generateState } from "../connectors/oauth/pkce";
import { putPending, takePending } from "../connectors/oauth/state-store";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubUser,
  githubOAuth,
} from "../connectors/oauth/providers/github";
import {
  googleOAuth,
  isGoogleProvider,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  fetchGoogleUser,
} from "../connectors/oauth/providers/google";
import { upsertConnector } from "../connectors/oauth/token-store";
import { isCryptoConfigured } from "../connectors/mcp/crypto";
import { requireFirebaseAuth } from "../middleware/firebase-auth-middleware";

const router = Router();

function publicBase(): string {
  return (process.env.YUA_PUBLIC_URL ?? "https://yuaone.com").replace(/\/$/, "");
}

function redirectUriFor(provider: string): string {
  return `${publicBase()}/api/connectors/${provider}/callback`;
}

function successRedirect(provider: string, ok: boolean, reason?: string): string {
  const base = `${publicBase()}/settings/connectors`;
  if (ok) return `${base}?connected=${provider}`;
  return `${base}?error=${encodeURIComponent(reason ?? "unknown")}&provider=${provider}`;
}

/* -------------------------------------------------------
 * POST /api/connectors/:id/authorize
 * Generates PKCE state + returns the provider authorize URL.
 * Client does window.location.href = url.
 * ----------------------------------------------------- */
router.post("/:id/authorize", requireFirebaseAuth, async (req: Request, res: Response) => {
  const userId = (req.user as any)?.userId;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const provider = String(req.params.id ?? "");

  if (!isCryptoConfigured()) {
    return res.status(503).json({
      ok: false,
      error: "CONNECTOR_ENC_KEY_NOT_SET",
      message: "서버 설정이 아직 준비되지 않았어요.",
    });
  }

  try {
    const verifier = generateVerifier();
    const challenge = computeChallenge(verifier);
    const state = generateState();

    await putPending(state, {
      userId: Number(userId),
      provider,
      verifier,
      createdAt: Date.now(),
    });

    let url: string | null = null;
    if (provider === "github") {
      if (!githubOAuth.configured) {
        return res.status(503).json({
          ok: false,
          error: "PROVIDER_NOT_CONFIGURED",
          message: "GitHub OAuth 앱이 아직 연결되지 않았어요.",
        });
      }
      url = buildGithubAuthorizeUrl({
        state,
        challenge,
        redirectUri: redirectUriFor("github"),
      });
    } else if (isGoogleProvider(provider)) {
      if (!googleOAuth.configured) {
        return res.status(503).json({
          ok: false,
          error: "PROVIDER_NOT_CONFIGURED",
          message: "Google OAuth 앱이 아직 연결되지 않았어요.",
        });
      }
      url = buildGoogleAuthorizeUrl({
        provider,
        state,
        challenge,
        redirectUri: redirectUriFor(provider),
      });
    } else {
      return res.status(400).json({
        ok: false,
        error: "PROVIDER_NOT_SUPPORTED",
        message: `${provider} OAuth는 아직 지원되지 않아요.`,
      });
    }

    return res.json({ ok: true, url });
  } catch (err: any) {
    console.error("[connectors-oauth] authorize failed", err);
    return res
      .status(500)
      .json({ ok: false, error: "authorize_failed", message: String(err?.message ?? "") });
  }
});

/* -------------------------------------------------------
 * GET /api/connectors/:id/callback?code=...&state=...
 * Provider redirect destination. Consumes the pending state,
 * exchanges code for tokens, stores encrypted, then redirects to /settings.
 * NO Firebase auth — trust is established via signed state + provider call.
 * ----------------------------------------------------- */
router.get("/:id/callback", async (req: Request, res: Response) => {
  const provider = String(req.params.id ?? "");
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";

  // Re-check crypto config — if CONNECTOR_ENC_KEY was rotated/removed between
  // authorize and callback, fail loudly BEFORE consuming the pending state
  // (so the user can retry the whole flow after admin fixes env).
  if (!isCryptoConfigured()) {
    return res.redirect(successRedirect(provider, false, "crypto_not_configured"));
  }

  if (!code || !state) {
    return res.redirect(successRedirect(provider, false, "missing_code_or_state"));
  }

  const pending = await takePending(state);
  if (!pending) {
    return res.redirect(successRedirect(provider, false, "invalid_state"));
  }
  if (pending.provider !== provider) {
    return res.redirect(successRedirect(provider, false, "provider_mismatch"));
  }

  try {
    if (provider === "github") {
      const tokens = await exchangeGithubCode({
        code,
        verifier: pending.verifier,
        redirectUri: redirectUriFor("github"),
      });

      if (!tokens.access_token) {
        return res.redirect(successRedirect(provider, false, "no_access_token"));
      }

      const user = await fetchGithubUser(tokens.access_token);

      await upsertConnector({
        userId: pending.userId,
        provider: "github",
        status: "connected",
        accessTokenPlain: tokens.access_token,
        refreshTokenPlain: tokens.refresh_token,
        scopes: (tokens.scope ?? "").split(/[,\s]+/).filter(Boolean),
        externalId: user?.id != null ? String(user.id) : null,
      });

      return res.redirect(successRedirect("github", true));
    }

    if (isGoogleProvider(provider)) {
      const tokens = await exchangeGoogleCode({
        code,
        verifier: pending.verifier,
        redirectUri: redirectUriFor(provider),
      });

      if (!tokens.access_token) {
        return res.redirect(successRedirect(provider, false, "no_access_token"));
      }

      const user = await fetchGoogleUser(tokens.access_token);

      const saved = await upsertConnector({
        userId: pending.userId,
        provider: provider as any,
        status: "connected",
        accessTokenPlain: tokens.access_token,
        refreshTokenPlain: tokens.refresh_token,
        scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
        externalId: user?.email ?? null,
      });

      // 🔥 Auto-sync tools immediately after OAuth (non-blocking)
      // So the settings UI shows tool count without waiting for first chat.
      import("../connectors/mcp/client-manager.js")
        .then(({ openUserMcpSession }) => openUserMcpSession(pending.userId, [provider]))
        .then((session) => session.close())
        .catch((e) => console.warn("[oauth-callback] auto-sync failed", e));

      return res.redirect(successRedirect(provider, true));
    }

    return res.redirect(successRedirect(provider, false, "unsupported"));
  } catch (err: any) {
    console.error("[connectors-oauth] callback failed", err);
    return res.redirect(successRedirect(provider, false, "exchange_failed"));
  }
});

export default router;
