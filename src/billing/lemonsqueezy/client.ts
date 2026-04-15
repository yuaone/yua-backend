// src/billing/lemonsqueezy/client.ts
// LemonSqueezy SDK setup + env accessors (SSOT).
// Placeholder-safe: throws with a clear error when env vars are "xx" or missing.

import { lemonSqueezySetup } from "@lemonsqueezy/lemonsqueezy.js";

let initialized = false;

function readEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  return v;
}

function isPlaceholder(v: string): boolean {
  return !v || v === "xx" || v === "XX";
}

/**
 * Initialize the LemonSqueezy SDK. Idempotent.
 * Throws if LEMONSQUEEZY_API_KEY is missing / placeholder.
 */
export function ensureLemonSqueezyClient(): void {
  if (initialized) return;
  const apiKey = readEnv("LEMONSQUEEZY_API_KEY");
  if (isPlaceholder(apiKey)) {
    throw new Error("LEMONSQUEEZY_API_KEY not configured");
  }
  lemonSqueezySetup({
    apiKey,
    onError: (err) => console.error("[ls]", err),
  });
  initialized = true;
}

/**
 * Return the configured store id. Throws if placeholder.
 */
export function getStoreId(): string {
  const v = readEnv("LEMONSQUEEZY_STORE_ID");
  if (isPlaceholder(v)) {
    throw new Error("LEMONSQUEEZY_STORE_ID not configured");
  }
  return v;
}

/**
 * Return the variant id for a given plan tier. Throws if placeholder.
 */
export function getVariantId(plan: "pro" | "max"): string {
  const key =
    plan === "pro"
      ? "LEMONSQUEEZY_PRO_VARIANT_ID"
      : "LEMONSQUEEZY_MAX_VARIANT_ID";
  const v = readEnv(key);
  if (isPlaceholder(v)) {
    throw new Error(`${key} not configured`);
  }
  return v;
}

/**
 * Safe (non-throwing) lookup of a variant id — returns null if placeholder.
 * Used by the webhook handler to map variant → plan_tier without blowing up
 * when LS isn't fully provisioned yet.
 */
export function tryGetVariantId(plan: "pro" | "max"): string | null {
  try {
    return getVariantId(plan);
  } catch {
    return null;
  }
}

/**
 * True iff every LemonSqueezy env var is set to a real (non-placeholder) value.
 * Used by the checkout endpoint to return 503 early.
 */
export function isLemonSqueezyConfigured(): boolean {
  const keys = [
    "LEMONSQUEEZY_API_KEY",
    "LEMONSQUEEZY_WEBHOOK_SECRET",
    "LEMONSQUEEZY_STORE_ID",
    "LEMONSQUEEZY_PRO_VARIANT_ID",
    "LEMONSQUEEZY_MAX_VARIANT_ID",
  ];
  for (const k of keys) {
    if (isPlaceholder(readEnv(k))) return false;
  }
  return true;
}

/**
 * Convenience getter — evaluated lazily every access so that flipping env
 * vars at runtime (PM2 restart with new .env) is picked up without a code
 * reload.
 */
export const LS_CONFIGURED = {
  get value(): boolean {
    return isLemonSqueezyConfigured();
  },
};
