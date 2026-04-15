// src/connectors/mcp/crypto.ts
// AES-256-GCM envelope encryption for OAuth access/refresh tokens stored in
// the `user_connectors` table. Never log the plaintext or the key.
//
// Payload layout (base64):
//   [ iv (12) | auth_tag (16) | ciphertext (N) ]
//
// Key: 32 bytes (64 hex chars) from env CONNECTOR_ENC_KEY. Generate once
// with `openssl rand -hex 32` and store in .env — rotation requires
// re-encrypting all stored tokens.

import crypto from "crypto";

const KEY_ENV = "CONNECTOR_ENC_KEY";

function getKey(): Buffer {
  const hex = (process.env[KEY_ENV] ?? "").trim();
  if (!hex) throw new Error(`${KEY_ENV} not set`);
  if (hex === "xx") throw new Error(`${KEY_ENV} is placeholder (xx)`);
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error(`${KEY_ENV} must be 32 bytes hex (64 chars)`);
  }
  return buf;
}

/**
 * Returns true if CONNECTOR_ENC_KEY is a usable real key (not xx/missing).
 * Callers can short-circuit connector flows if the key isn't provisioned.
 */
export function isCryptoConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptToken(encrypted: string | null | undefined): string {
  if (!encrypted) return "";
  const key = getKey();
  const buf = Buffer.from(encrypted, "base64");
  if (buf.length < 12 + 16 + 1) throw new Error("corrupt encrypted token");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
