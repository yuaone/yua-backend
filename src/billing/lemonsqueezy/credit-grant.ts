// src/billing/lemonsqueezy/credit-grant.ts
// Credit ledger mutations — purchase / grant / refund / consume.
// Single SSOT for user_credits + user_credit_ledger writes.
//
// All writes go through a single PG transaction so balance and ledger stay
// consistent even if the process crashes mid-write.

import { pgPool } from "../../db/postgres";

export type CreditTxType =
  | "purchase"
  | "grant_admin"
  | "grant_promo"
  | "consume"
  | "refund"
  | "expire";

export interface CreditMutation {
  userId: number;
  type: CreditTxType;
  amountCents: number;   // signed: +credit, -debit
  refType?: "ls_order" | "usage_log_id" | "admin" | null;
  refId?: string | null;
  note?: string | null;
}

export interface CreditMutationResult {
  ok: boolean;
  balanceCents: number;
  ledgerId: number | null;
  duplicate: boolean;
  insufficient: boolean;
}

/**
 * Apply a credit mutation atomically. Returns the post-mutation balance
 * and the new ledger row id. If the mutation is a purchase and the same
 * (ref_type='ls_order', ref_id) already exists, returns duplicate=true
 * without touching the balance (webhook idempotency).
 */
export async function applyCreditMutation(
  m: CreditMutation
): Promise<CreditMutationResult> {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");

    // Dedup check for LS-sourced mutations (webhook retry protection).
    // Both `purchase` and `refund` are keyed by (ref_type='ls_order', ref_id, type)
    // so a re-delivered order_created / order_refunded webhook does not
    // double-apply. billing_events.ls_event_id UNIQUE is the outer guard;
    // this is defense-in-depth at the ledger layer.
    if (
      (m.type === "purchase" || m.type === "refund") &&
      m.refType === "ls_order" &&
      m.refId
    ) {
      const dup = await client.query(
        `SELECT id FROM user_credit_ledger
          WHERE ref_type = 'ls_order'
            AND ref_id = $1
            AND type = $2
          LIMIT 1`,
        [m.refId, m.type],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        await client.query("ROLLBACK");
        // Return current balance (no-op)
        const bal = await fetchBalance(m.userId);
        return {
          ok: true,
          balanceCents: bal,
          ledgerId: null,
          duplicate: true,
          insufficient: false,
        };
      }
    }

    const delta = Math.round(m.amountCents);

    // Atomic UPSERT with increment — avoids the SELECT-then-UPDATE race
    // that existed when two concurrent mutations targeted a brand-new user
    // (FOR UPDATE cannot lock a row that does not yet exist).
    //
    // Semantics:
    //   - If no row exists: INSERT with balance = max(delta, 0). If delta is
    //     negative (consume/refund on a user with no credits), we short-circuit
    //     below because newBalance < 0 is impossible only when delta >= 0.
    //   - If row exists: UPDATE adds delta to the current locked value,
    //     guarded by a WHERE clause that rejects negative balances. If the
    //     WHERE fails, RETURNING yields zero rows → insufficient funds.
    //
    // For negative deltas on a non-existent user row, pre-check: if no row
    // and delta < 0 → insufficient without touching DB (we still rollback
    // to release resources cleanly).
    if (delta < 0) {
      const pre = await client.query(
        `SELECT balance_usd_cents FROM user_credits WHERE user_id = $1 LIMIT 1`,
        [m.userId],
      );
      if (pre.rowCount === 0) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          balanceCents: 0,
          ledgerId: null,
          duplicate: false,
          insufficient: true,
        };
      }
    }

    const upsert = await client.query<{ balance_usd_cents: string }>(
      `INSERT INTO user_credits (user_id, balance_usd_cents, updated_at)
         VALUES ($1, GREATEST($2::bigint, 0), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET balance_usd_cents = user_credits.balance_usd_cents + $2::bigint,
             updated_at = NOW()
         WHERE user_credits.balance_usd_cents + $2::bigint >= 0
       RETURNING balance_usd_cents`,
      [m.userId, delta],
    );

    if (upsert.rowCount === 0) {
      // WHERE clause blocked the update — insufficient funds.
      await client.query("ROLLBACK");
      const current = await fetchBalance(m.userId);
      return {
        ok: false,
        balanceCents: current,
        ledgerId: null,
        duplicate: false,
        insufficient: true,
      };
    }

    const newBalance = Number(upsert.rows[0]!.balance_usd_cents) || 0;

    // Append ledger row (balance_after is the ACTUAL post-mutation balance
    // returned by RETURNING, not a stale pre-read value).
    const ins = await client.query<{ id: string }>(
      `INSERT INTO user_credit_ledger
         (user_id, type, amount_cents, balance_after_cents, ref_type, ref_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        m.userId,
        m.type,
        delta,
        newBalance,
        m.refType ?? null,
        m.refId ?? null,
        m.note ?? null,
      ]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      balanceCents: newBalance,
      ledgerId: Number(ins.rows[0]!.id),
      duplicate: false,
      insufficient: false,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read the current credit balance for a user. Returns 0 if no row.
 */
export async function fetchBalance(userId: number): Promise<number> {
  const r = await pgPool.query<{ balance_usd_cents: string }>(
    `SELECT balance_usd_cents FROM user_credits WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (r.rowCount === 0) return 0;
  return Number(r.rows[0]!.balance_usd_cents) || 0;
}

/**
 * Map a LemonSqueezy variant id to the credit pack amount in USD cents.
 * Returns null if the variant id doesn't match any known credit pack.
 */
export function mapVariantToCreditCents(variantId: string | null): number | null {
  if (!variantId) return null;
  const v = String(variantId);
  const packs: Array<[string, number]> = [
    [process.env.LEMONSQUEEZY_CREDITS_10_VARIANT_ID ?? "", 10_00],
    [process.env.LEMONSQUEEZY_CREDITS_25_VARIANT_ID ?? "", 25_00],
    [process.env.LEMONSQUEEZY_CREDITS_50_VARIANT_ID ?? "", 50_00],
    [process.env.LEMONSQUEEZY_CREDITS_100_VARIANT_ID ?? "", 100_00],
  ];
  for (const [envId, cents] of packs) {
    if (envId && envId !== "xx" && envId === v) return cents;
  }
  return null;
}
