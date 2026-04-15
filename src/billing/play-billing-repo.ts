import { pgPool } from "../db/postgres";

type UpsertPlayPurchaseInput = {
  workspaceId: string;
  userId: number;
  productType: "subscription" | "product";
  productId: string;
  purchaseToken: string;
  orderId?: string | null;
  entitlementStatus: "active" | "revoked" | "pending";
  purchaseState?: string | null;
  expiryTime?: string | null;
  acknowledged: boolean;
  revoked: boolean;
  rawPayload: unknown;
};

export async function upsertGooglePlayPurchase(input: UpsertPlayPurchaseInput) {
  const { rows } = await pgPool.query(
    `
    INSERT INTO google_play_purchases (
      workspace_id,
      user_id,
      product_type,
      product_id,
      purchase_token,
      order_id,
      entitlement_status,
      purchase_state,
      expiry_time,
      acknowledged_at,
      revoked_at,
      raw_payload,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::jsonb, NOW())
    ON CONFLICT (purchase_token)
    DO UPDATE SET
      product_type = EXCLUDED.product_type,
      product_id = EXCLUDED.product_id,
      order_id = EXCLUDED.order_id,
      entitlement_status = EXCLUDED.entitlement_status,
      purchase_state = EXCLUDED.purchase_state,
      expiry_time = EXCLUDED.expiry_time,
      acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, google_play_purchases.acknowledged_at),
      revoked_at = EXCLUDED.revoked_at,
      raw_payload = EXCLUDED.raw_payload,
      updated_at = NOW()
    WHERE google_play_purchases.workspace_id = EXCLUDED.workspace_id
      AND google_play_purchases.user_id = EXCLUDED.user_id
    RETURNING *
    `,
    [
      input.workspaceId,
      input.userId,
      input.productType,
      input.productId,
      input.purchaseToken,
      input.orderId ?? null,
      input.entitlementStatus,
      input.purchaseState ?? null,
      input.expiryTime ?? null,
      input.acknowledged ? new Date() : null,
      input.revoked ? new Date() : null,
      JSON.stringify(input.rawPayload ?? {}),
    ]
  );

  if (!rows[0]) {
    throw new Error("play_purchase_token_rebinding_detected");
  }

  return rows[0];
}

export async function findActiveGooglePlaySubscription(workspaceId: string) {
  const { rows } = await pgPool.query(
    `
    SELECT *
    FROM google_play_purchases
    WHERE workspace_id = $1
      AND product_type = 'subscription'
      AND entitlement_status = 'active'
      AND revoked_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [workspaceId]
  );

  return rows[0] ?? null;
}

export async function revokeGooglePlayPurchaseByToken(purchaseToken: string) {
  const { rows } = await pgPool.query(
    `
    UPDATE google_play_purchases
    SET entitlement_status = 'revoked',
        revoked_at = NOW(),
        updated_at = NOW()
    WHERE purchase_token = $1
    RETURNING *
    `,
    [purchaseToken]
  );

  return rows[0] ?? null;
}
