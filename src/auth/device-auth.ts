// src/auth/device-auth.ts
// Device token authentication — CLI/Desktop/SDK permanent tokens

import crypto from "crypto";
import { pgPool } from "../db/postgres";

export interface DeviceToken {
  id: number;
  user_id: number;
  token_prefix: string;
  device_name: string | null;
  client_type: string;
  last_used_at: Date | null;
  created_at: Date;
}

/** Generate a new device token for a user */
export async function issueDeviceToken(
  userId: number,
  deviceName: string,
  clientType: "cli" | "desktop" | "sdk",
): Promise<string> {
  const raw = `ydt_${crypto.randomBytes(32).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 8);

  await pgPool.query(
    `INSERT INTO device_tokens (user_id, token_hash, token_prefix, device_name, client_type)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hash, prefix, deviceName, clientType],
  );

  return raw;
}

/** Verify a device token and return the user_id, or null if invalid */
export async function verifyDeviceToken(
  token: string,
): Promise<{ userId: number; clientType: string } | null> {
  if (!token.startsWith("ydt_")) return null;

  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const result = await pgPool.query(
    `UPDATE device_tokens SET last_used_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING user_id, client_type`,
    [hash],
  );

  if (result.rows.length === 0) return null;
  return { userId: result.rows[0].user_id, clientType: result.rows[0].client_type };
}

/** Revoke a device token */
export async function revokeDeviceToken(tokenId: number, userId: number): Promise<boolean> {
  const result = await pgPool.query(
    `UPDATE device_tokens SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tokenId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** List active device tokens for a user */
export async function listDeviceTokens(userId: number): Promise<DeviceToken[]> {
  const result = await pgPool.query(
    `SELECT id, user_id, token_prefix, device_name, client_type, last_used_at, created_at
     FROM device_tokens WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}
