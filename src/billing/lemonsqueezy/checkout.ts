// src/billing/lemonsqueezy/checkout.ts
// Thin wrapper around LS createCheckout.
// Injects custom_data so the webhook handler can round-trip userId/workspaceId.

import { createCheckout } from "@lemonsqueezy/lemonsqueezy.js";
import {
  ensureLemonSqueezyClient,
  getStoreId,
  getVariantId,
  isLemonSqueezyConfigured,
} from "./client";

export interface CreateCheckoutParams {
  userId: number;
  workspaceId: number | null;
  email: string;
  plan: "pro" | "max";
}

export interface CreateCheckoutResult {
  url: string;
}

/**
 * Create a LemonSqueezy hosted checkout URL for the given user/plan.
 * Throws `LS_NOT_CONFIGURED` if any LS env var is still a placeholder.
 */
export async function createUserCheckout(
  params: CreateCheckoutParams
): Promise<CreateCheckoutResult> {
  if (!isLemonSqueezyConfigured()) {
    throw new Error("LS_NOT_CONFIGURED");
  }

  ensureLemonSqueezyClient();

  const storeId = getStoreId();
  const variantId = getVariantId(params.plan);

  const redirectBase =
    (process.env.YUA_PUBLIC_URL ?? "https://yuaone.com").replace(/\/$/, "");

  const { data, error } = await createCheckout(storeId, variantId, {
    checkoutData: {
      email: params.email,
      custom: {
        userId: String(params.userId),
        workspaceId: params.workspaceId != null ? String(params.workspaceId) : "",
        plan: params.plan,
      },
    },
    productOptions: {
      // Post-payment redirect lands on the Billing settings tab so the user
      // immediately sees their newly-active plan card. The `?checkout=success`
      // query string lets BillingPanel show a brief success toast + force
      // a subscription refresh even before the webhook lands.
      redirectUrl: `${redirectBase}/settings/billing?checkout=success`,
      receiptButtonText: "YUA로 돌아가기",
    },
    checkoutOptions: {
      // Full-page hosted checkout (NOT overlay). Overlay requires loading
      // app.lemonsqueezy.com JS which is blocked by our CSP — switch to
      // overlay later after updating CSP (see audit C3).
      embed: false,
      dark: true,
      logo: true,
    },
  });

  if (error) {
    console.error("[ls-checkout] createCheckout error", error);
    throw new Error(`LS_CHECKOUT_FAILED: ${error.message ?? "unknown"}`);
  }

  const url = (data as any)?.data?.attributes?.url;
  if (!url || typeof url !== "string") {
    throw new Error("LS_CHECKOUT_FAILED: missing url in response");
  }

  return { url };
}
