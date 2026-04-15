// src/connectors/oauth/token-store.ts
// CRUD for the user_connectors table with AES-256-GCM envelope encryption.
// This is the only module that touches access_token/refresh_token columns.

import { pgPool } from "../../db/postgres";
import { encryptToken, decryptToken } from "../mcp/crypto";
import type { ConnectorStatus } from "yua-shared";

export type { ConnectorStatus };

export interface StoredConnector {
  id: number;
  userId: number;
  provider: string;
  status: ConnectorStatus;
  scopes: string[];
  externalId: string | null;
  connectedAt: string;
  updatedAt: string;
  serverUrl: string | null;
  displayName: string;
  authType: string;
  isCustom: boolean;
  toolCount: number;
  lastSynced: string | null;
}

export interface StoredConnectorWithSecrets extends StoredConnector {
  accessToken: string;   // plaintext, only inside the MCP client flow
  refreshToken: string;
}

function mapRow(row: any): StoredConnector {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    provider: String(row.provider),
    status: String(row.status) as ConnectorStatus,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    externalId: row.external_id ?? null,
    connectedAt: new Date(row.connected_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    serverUrl: row.server_url ?? null,
    displayName: row.display_name || row.provider,
    authType: row.auth_type ?? "oauth",
    isCustom: Boolean(row.is_custom),
    toolCount: Number(row.tool_count ?? 0),
    lastSynced: row.last_synced ? new Date(row.last_synced).toISOString() : null,
  };
}

export async function upsertConnector(input: {
  userId: number;
  provider: string;
  status: ConnectorStatus;
  accessTokenPlain: string;
  refreshTokenPlain?: string;
  scopes?: string[];
  externalId?: string | null;
  serverUrl?: string | null;
  displayName?: string | null;
  authType?: string;
  isCustom?: boolean;
}): Promise<StoredConnector> {
  const accessEnc = encryptToken(input.accessTokenPlain);
  const refreshEnc = input.refreshTokenPlain
    ? encryptToken(input.refreshTokenPlain)
    : null;

  const { rows } = await pgPool.query(
    `INSERT INTO user_connectors
       (user_id, provider, status, access_token, refresh_token, scopes, external_id,
        server_url, display_name, auth_type, is_custom, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       status        = EXCLUDED.status,
       access_token  = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, user_connectors.refresh_token),
       scopes        = EXCLUDED.scopes,
       external_id   = EXCLUDED.external_id,
       server_url    = COALESCE(EXCLUDED.server_url, user_connectors.server_url),
       display_name  = COALESCE(EXCLUDED.display_name, user_connectors.display_name),
       auth_type     = COALESCE(EXCLUDED.auth_type, user_connectors.auth_type),
       is_custom     = COALESCE(EXCLUDED.is_custom, user_connectors.is_custom),
       updated_at    = NOW()
     RETURNING *`,
    [
      input.userId,
      input.provider,
      input.status,
      accessEnc,
      refreshEnc,
      input.scopes ?? [],
      input.externalId ?? null,
      input.serverUrl ?? null,
      input.displayName ?? null,
      input.authType ?? "oauth",
      input.isCustom ?? false,
    ],
  );
  return mapRow(rows[0]);
}

export async function findConnector(
  userId: number,
  provider: string,
): Promise<StoredConnector | null> {
  const { rows } = await pgPool.query(
    `SELECT * FROM user_connectors WHERE user_id = $1 AND provider = $2 LIMIT 1`,
    [userId, provider],
  );
  if (rows.length === 0) return null;
  return mapRow(rows[0]);
}

export async function listActiveConnectors(
  userId: number,
): Promise<StoredConnector[]> {
  const { rows } = await pgPool.query(
    `SELECT * FROM user_connectors WHERE user_id = $1 AND status = 'connected' ORDER BY provider ASC`,
    [userId],
  );
  return rows.map(mapRow);
}

/**
 * Internal helper for MCP client manager — reads the encrypted tokens and
 * returns them decrypted together with the metadata. Use ONLY in MCP flow.
 */
export async function loadConnectorWithSecrets(
  userId: number,
  provider: string,
): Promise<StoredConnectorWithSecrets | null> {
  const { rows } = await pgPool.query(
    `SELECT * FROM user_connectors WHERE user_id = $1 AND provider = $2 LIMIT 1`,
    [userId, provider],
  );
  if (rows.length === 0) return null;
  const base = mapRow(rows[0]);
  return {
    ...base,
    accessToken: decryptToken(rows[0].access_token),
    refreshToken: decryptToken(rows[0].refresh_token),
  };
}

// ── Google OAuth Token Refresh ──
// Google access_token expires in 1 hour. This function uses the stored
// refresh_token to get a new access_token and updates DB.
// Returns the new access_token or null on failure.
const GOOGLE_PROVIDERS = new Set(["gmail", "gdrive", "google_calendar"]);
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000; // 50 minutes (refresh before 60min expiry)

export function isGoogleProvider(provider: string): boolean {
  return GOOGLE_PROVIDERS.has(provider);
}

export function isTokenLikelyExpired(updatedAt: string): boolean {
  const age = Date.now() - new Date(updatedAt).getTime();
  return age > TOKEN_MAX_AGE_MS;
}

export async function refreshGoogleToken(
  userId: number,
  provider: string,
): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn("[token-refresh] GOOGLE_CLIENT_ID/SECRET missing");
    return null;
  }

  // Load current refresh_token from DB
  const withSecrets = await loadConnectorWithSecrets(userId, provider);
  if (!withSecrets?.refreshToken) {
    console.warn("[token-refresh] no refresh_token for", { userId, provider });
    await pgPool.query(
      `UPDATE user_connectors SET status = 'expired', updated_at = NOW() WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    return null;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: withSecrets.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[token-refresh] Google returned", res.status, body);
      // Mark as expired so frontend can show real state
      if (res.status === 400 || res.status === 401) {
        await pgPool.query(
          `UPDATE user_connectors SET status = 'expired', updated_at = NOW() WHERE user_id = $1 AND provider = $2`,
          [userId, provider],
        );
      }
      return null;
    }

    const data: any = await res.json();
    const newAccessToken: string = data.access_token;
    if (!newAccessToken) return null;

    // Update DB with new encrypted access_token
    const accessEnc = encryptToken(newAccessToken);
    await pgPool.query(
      `UPDATE user_connectors SET access_token = $1, status = 'connected', updated_at = NOW() WHERE user_id = $2 AND provider = $3`,
      [accessEnc, userId, provider],
    );

    console.log("[token-refresh] OK", { userId, provider, expiresIn: data.expires_in });
    return newAccessToken;
  } catch (err: any) {
    console.error("[token-refresh] failed", { userId, provider, error: err?.message });
    return null;
  }
}

export async function deleteConnector(
  userId: number,
  provider: string,
): Promise<void> {
  await pgPool.query(
    `DELETE FROM user_connectors WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
}

export async function markRevoked(
  userId: number,
  provider: string,
): Promise<void> {
  await pgPool.query(
    `UPDATE user_connectors SET status = 'revoked', updated_at = NOW()
      WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
}

export async function listAllConnectors(
  userId: number,
): Promise<StoredConnector[]> {
  const { rows } = await pgPool.query(
    `SELECT * FROM user_connectors WHERE user_id = $1 ORDER BY provider ASC`,
    [userId],
  );
  return rows.map(mapRow);
}
