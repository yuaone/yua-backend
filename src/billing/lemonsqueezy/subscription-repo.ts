// src/billing/lemonsqueezy/subscription-repo.ts
// Postgres CRUD for the billing_subscriptions table.
// Schema is defined in migrations/2026-04-11-billing-and-settings.sql.

import { pgPool } from "../../db/postgres";

export interface BillingSubscription {
  id: number;
  userId: number;
  workspaceId: number | null;
  planTier: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  updateUrl: string | null;
  cancelUrl: string | null;
}

interface UpsertInput {
  userId: number;
  workspaceId?: number | null;
  lsSubscriptionId: string;
  lsCustomerId?: string;
  lsVariantId?: string;
  lsOrderId?: string;
  planTier: string;
  status: string;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  updateUrl?: string | null;
  cancelUrl?: string | null;
  trialEndsAt?: string | null;
}

function mapRow(row: any): BillingSubscription {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    workspaceId: row.workspace_id != null ? Number(row.workspace_id) : null,
    planTier: String(row.plan_tier),
    status: String(row.status),
    currentPeriodEnd: row.current_period_end
      ? new Date(row.current_period_end).toISOString()
      : null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    updateUrl: row.update_url ?? null,
    cancelUrl: row.cancel_url ?? null,
  };
}

/**
 * Upsert a LemonSqueezy subscription keyed by ls_subscription_id.
 * Uses the partial unique index on ls_subscription_id.
 */
export async function upsertSubscription(
  input: UpsertInput
): Promise<BillingSubscription> {
  const sql = `
    INSERT INTO billing_subscriptions (
      user_id, workspace_id, provider,
      ls_subscription_id, ls_customer_id, ls_variant_id, ls_order_id,
      plan_tier, status,
      current_period_start, current_period_end,
      cancel_at_period_end, update_url, cancel_url, trial_ends_at,
      created_at, updated_at
    ) VALUES (
      $1, $2, 'lemonsqueezy',
      $3, $4, $5, $6,
      $7, $8,
      $9, $10,
      COALESCE($11, false), $12, $13, $14,
      NOW(), NOW()
    )
    ON CONFLICT (ls_subscription_id) WHERE ls_subscription_id IS NOT NULL DO UPDATE SET
      user_id              = EXCLUDED.user_id,
      workspace_id         = EXCLUDED.workspace_id,
      ls_customer_id       = COALESCE(EXCLUDED.ls_customer_id, billing_subscriptions.ls_customer_id),
      ls_variant_id        = COALESCE(EXCLUDED.ls_variant_id,  billing_subscriptions.ls_variant_id),
      ls_order_id          = COALESCE(EXCLUDED.ls_order_id,    billing_subscriptions.ls_order_id),
      plan_tier            = EXCLUDED.plan_tier,
      status               = EXCLUDED.status,
      current_period_start = COALESCE(EXCLUDED.current_period_start, billing_subscriptions.current_period_start),
      current_period_end   = COALESCE(EXCLUDED.current_period_end,   billing_subscriptions.current_period_end),
      cancel_at_period_end = EXCLUDED.cancel_at_period_end,
      update_url           = COALESCE(EXCLUDED.update_url,   billing_subscriptions.update_url),
      cancel_url           = COALESCE(EXCLUDED.cancel_url,   billing_subscriptions.cancel_url),
      trial_ends_at        = COALESCE(EXCLUDED.trial_ends_at,billing_subscriptions.trial_ends_at),
      updated_at           = NOW()
    RETURNING *;
  `;

  const params = [
    input.userId,
    input.workspaceId ?? null,
    input.lsSubscriptionId,
    input.lsCustomerId ?? null,
    input.lsVariantId ?? null,
    input.lsOrderId ?? null,
    input.planTier,
    input.status,
    input.currentPeriodStart ?? null,
    input.currentPeriodEnd ?? null,
    input.cancelAtPeriodEnd ?? null,
    input.updateUrl ?? null,
    input.cancelUrl ?? null,
    input.trialEndsAt ?? null,
  ];

  const { rows } = await pgPool.query(sql, params);
  return mapRow(rows[0]);
}

/**
 * Find the most recent active (or past_due / trialing) subscription for a user.
 * Returns null if nothing found → caller should default to "free".
 */
export async function findActiveByUser(
  userId: number
): Promise<BillingSubscription | null> {
  const sql = `
    SELECT *
    FROM billing_subscriptions
    WHERE user_id = $1
      AND status IN ('active', 'trialing', 'past_due')
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 ELSE 2 END,
      current_period_end DESC NULLS LAST,
      id DESC
    LIMIT 1;
  `;
  const { rows } = await pgPool.query(sql, [userId]);
  if (rows.length === 0) return null;
  return mapRow(rows[0]);
}

/**
 * Update status (and optionally current_period_end) for a given LS subscription.
 */
export async function updateStatus(
  lsSubscriptionId: string,
  status: string,
  currentPeriodEnd?: string | null
): Promise<void> {
  if (currentPeriodEnd) {
    await pgPool.query(
      `UPDATE billing_subscriptions
          SET status = $2,
              current_period_end = $3,
              updated_at = NOW()
        WHERE ls_subscription_id = $1`,
      [lsSubscriptionId, status, currentPeriodEnd]
    );
  } else {
    await pgPool.query(
      `UPDATE billing_subscriptions
          SET status = $2,
              updated_at = NOW()
        WHERE ls_subscription_id = $1`,
      [lsSubscriptionId, status]
    );
  }
}

/**
 * Fetch user_id for a given ls_subscription_id. Used by webhook handler to
 * invalidate the plan_tier cache when the inbound payload only gives us the
 * subscription id (no custom_data).
 */
export async function findUserIdBySubscription(
  lsSubscriptionId: string
): Promise<number | null> {
  const { rows } = await pgPool.query(
    `SELECT user_id FROM billing_subscriptions WHERE ls_subscription_id = $1 LIMIT 1`,
    [lsSubscriptionId]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].user_id);
}
