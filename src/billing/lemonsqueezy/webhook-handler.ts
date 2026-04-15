// src/billing/lemonsqueezy/webhook-handler.ts
// HMAC-verified, idempotent LemonSqueezy webhook dispatch.
//
// Security notes:
//   - HMAC is computed over the RAW request bytes. The router MUST mount
//     express.raw({type: "application/json"}) before invoking this handler.
//   - Signature comparison uses crypto.timingSafeEqual to avoid timing attacks.
//   - Idempotency is enforced at the DB level via billing_events.ls_event_id UNIQUE.
//   - Nothing in this file ever logs the webhook secret or API key.

import crypto from "crypto";
import { pgPool } from "../../db/postgres";
import { redisPub } from "../../db/redis";
import {
  upsertSubscription,
  updateStatus,
  findUserIdBySubscription,
} from "./subscription-repo";
import { tryGetVariantId } from "./client";
import {
  applyCreditMutation,
  mapVariantToCreditCents,
} from "./credit-grant";

type WebhookResult = { status: number; body: any };

function readSecret(): string {
  return (process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? "").trim();
}

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const secret = readSecret();
  if (!secret || secret === "xx") return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;

  try {
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

interface InsertEventResult {
  id: number | null;
  duplicate: boolean;
}

async function insertEventIdempotent(
  lsEventId: string,
  eventName: string,
  payload: any
): Promise<InsertEventResult> {
  const { rows } = await pgPool.query(
    `INSERT INTO billing_events (ls_event_id, event_name, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (ls_event_id) DO NOTHING
     RETURNING id`,
    [lsEventId, eventName, payload]
  );
  if (rows.length === 0) return { id: null, duplicate: true };
  return { id: Number(rows[0].id), duplicate: false };
}

function mapVariantToPlan(variantId: string | number | null | undefined): string | null {
  if (variantId == null) return null;
  const v = String(variantId);
  const pro = tryGetVariantId("pro");
  const max = tryGetVariantId("max");
  if (pro && v === pro) return "pro";
  if (max && v === max) return "max";
  return null;
}

async function invalidatePlanTierCache(userId: number | null | undefined): Promise<void> {
  if (!userId || !Number.isFinite(userId)) return;
  try {
    // `del` exists on the ioredis client — redisPub is a plain Redis instance.
    await (redisPub as any).del(`plan_tier:user:${userId}`);
  } catch (err) {
    console.warn("[ls-webhook] cache invalidate failed", err);
  }
}

interface ParsedPayload {
  eventName: string;
  eventId: string | null;
  userIdCustom: number | null;
  workspaceIdCustom: number | null;
  planCustom: "pro" | "max" | null;
  data: any;
}

function parsePayload(raw: Buffer): ParsedPayload | null {
  let json: any;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  const meta = json?.meta ?? {};
  const eventName = String(meta.event_name ?? "");
  const eventId =
    typeof meta.webhook_id === "string" && meta.webhook_id
      ? `${meta.webhook_id}:${eventName}:${json?.data?.id ?? ""}`
      : typeof meta.event_id === "string"
        ? meta.event_id
        : null;

  const custom = meta.custom_data ?? {};
  const uidRaw = custom.userId ?? custom.user_id;
  const wsRaw = custom.workspaceId ?? custom.workspace_id;
  const planRaw = typeof custom.plan === "string" ? custom.plan.toLowerCase() : null;

  return {
    eventName,
    eventId,
    userIdCustom: uidRaw != null && uidRaw !== "" ? Number(uidRaw) : null,
    workspaceIdCustom: wsRaw != null && wsRaw !== "" ? Number(wsRaw) : null,
    planCustom: planRaw === "pro" || planRaw === "max" ? planRaw : null,
    data: json?.data ?? null,
  };
}

/**
 * Main entry. Returns {status, body} for the router to send.
 * Router is responsible for `res.status(result.status).json(result.body)`.
 */
export async function handleLemonSqueezyWebhook(
  rawBody: Buffer,
  signature: string | undefined
): Promise<WebhookResult> {
  // 1. HMAC verification BEFORE any JSON parsing.
  if (!verifySignature(rawBody, signature)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }

  // 2. Parse after verification passes.
  const parsed = parsePayload(rawBody);
  if (!parsed) {
    return { status: 400, body: { error: "invalid_payload" } };
  }

  const { eventName, data } = parsed;

  // 3. Idempotency key — prefer meta.webhook_id combined with data id/event name.
  //    If LS didn't give us one, synthesize a stable-ish key from the payload.
  //    Fallback includes a hash of the full payload so two same-second retries
  //    with identical (id, updated_at, event_name) but different sub-fields
  //    don't silently collide. Logged so we can audit how often LS fails to
  //    supply webhook_id.
  let eventIdKey: string;
  if (parsed.eventId) {
    eventIdKey = parsed.eventId;
  } else {
    const payloadHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(data ?? {}))
      .digest("hex")
      .slice(0, 12);
    eventIdKey = `${eventName}:${data?.id ?? ""}:${
      data?.attributes?.updated_at ?? ""
    }:${payloadHash}`;
    console.warn(
      "[ls-webhook] meta.webhook_id missing — synthesized key",
      { eventName, dataId: data?.id, key: eventIdKey }
    );
  }

  if (!eventIdKey) {
    return { status: 400, body: { error: "missing_event_id" } };
  }

  let idempotency: InsertEventResult;
  try {
    idempotency = await insertEventIdempotent(eventIdKey, eventName, JSON.parse(rawBody.toString("utf8")));
  } catch (err) {
    console.error("[ls-webhook] idempotency insert failed", err);
    return { status: 500, body: { error: "db_error" } };
  }

  if (idempotency.duplicate) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  // 4. Dispatch by event name.
  try {
    await dispatchEvent(eventName, data, parsed);
  } catch (err) {
    console.error("[ls-webhook] dispatch error", eventName, err);
    // Return 200 anyway — we've recorded the event, LS will not retry,
    // and we can replay from billing_events if needed.
    return { status: 200, body: { ok: true, warning: "dispatch_failed" } };
  }

  return { status: 200, body: { ok: true } };
}

async function dispatchEvent(
  eventName: string,
  data: any,
  parsed: ParsedPayload
): Promise<void> {
  const attrs = data?.attributes ?? {};
  const lsSubscriptionId = data?.id != null ? String(data.id) : null;

  // Derive plan tier: prefer custom.plan (from our checkout flow), fall back
  // to variant id mapping.
  const variantId = attrs.variant_id ?? attrs.variantId ?? null;
  const planFromVariant = mapVariantToPlan(variantId);
  const planTier = parsed.planCustom ?? planFromVariant;

  const userId = parsed.userIdCustom;

  switch (eventName) {
    case "subscription_created":
    case "subscription_updated":
    case "subscription_resumed":
    case "subscription_unpaused": {
      if (!lsSubscriptionId) return;
      if (!planTier) {
        console.warn(
          "[ls-webhook] unknown variant — skipping upsert",
          { variantId, eventName }
        );
        return;
      }
      if (!userId) {
        console.warn("[ls-webhook] missing custom_data.userId — cannot upsert");
        return;
      }

      const statusRaw: string = String(attrs.status ?? "active");
      // LS returns statuses like 'active', 'cancelled', 'past_due', 'expired', 'paused'.
      const status =
        statusRaw === "on_trial" ? "trialing" : statusRaw;

      await upsertSubscription({
        userId,
        workspaceId: parsed.workspaceIdCustom,
        lsSubscriptionId,
        lsCustomerId: attrs.customer_id != null ? String(attrs.customer_id) : undefined,
        lsVariantId: variantId != null ? String(variantId) : undefined,
        lsOrderId: attrs.order_id != null ? String(attrs.order_id) : undefined,
        planTier,
        status,
        currentPeriodStart: attrs.renews_at ?? null,
        currentPeriodEnd: attrs.ends_at ?? attrs.renews_at ?? null,
        cancelAtPeriodEnd: Boolean(attrs.cancelled),
        updateUrl: attrs.urls?.update_payment_method ?? null,
        cancelUrl: attrs.urls?.customer_portal ?? null,
        trialEndsAt: attrs.trial_ends_at ?? null,
      });
      await invalidatePlanTierCache(userId);
      return;
    }

    case "subscription_cancelled":
    case "subscription_expired": {
      if (!lsSubscriptionId) return;
      await updateStatus(
        lsSubscriptionId,
        eventName === "subscription_cancelled" ? "cancelled" : "expired",
        attrs.ends_at ?? null
      );
      const uid = userId ?? (await findUserIdBySubscription(lsSubscriptionId));
      await invalidatePlanTierCache(uid);
      return;
    }

    case "subscription_payment_success": {
      if (!lsSubscriptionId) return;
      await updateStatus(lsSubscriptionId, "active", attrs.renews_at ?? null);
      const uid = userId ?? (await findUserIdBySubscription(lsSubscriptionId));
      await invalidatePlanTierCache(uid);
      return;
    }

    case "subscription_payment_failed": {
      if (!lsSubscriptionId) return;
      await updateStatus(lsSubscriptionId, "past_due");
      const uid = userId ?? (await findUserIdBySubscription(lsSubscriptionId));
      await invalidatePlanTierCache(uid);
      return;
    }

    case "subscription_paused": {
      if (!lsSubscriptionId) return;
      await updateStatus(lsSubscriptionId, "paused");
      const uid = userId ?? (await findUserIdBySubscription(lsSubscriptionId));
      await invalidatePlanTierCache(uid);
      return;
    }

    case "subscription_payment_refunded": {
      // Subscription charge was refunded → downgrade immediately.
      if (!lsSubscriptionId) return;
      await updateStatus(lsSubscriptionId, "refunded");
      const uid = userId ?? (await findUserIdBySubscription(lsSubscriptionId));
      await invalidatePlanTierCache(uid);
      return;
    }

    case "order_created": {
      // One-time purchase (credit pack). Grant credits to the user's ledger.
      // ls custom_data carries the userId, same as subscription flow.
      if (!userId) {
        console.warn("[ls-webhook] order_created missing custom.userId");
        return;
      }
      const orderId = data?.id != null ? String(data.id) : null;
      const firstItem = attrs.first_order_item ?? null;
      const orderVariantId = firstItem?.variant_id ?? null;
      const creditCents = mapVariantToCreditCents(
        orderVariantId != null ? String(orderVariantId) : null
      );
      if (!creditCents || !orderId) {
        // Not a known credit pack (might be a subscription order) — skip.
        return;
      }
      try {
        const r = await applyCreditMutation({
          userId,
          type: "purchase",
          amountCents: creditCents,
          refType: "ls_order",
          refId: orderId,
          note: `LS credit pack ${creditCents / 100} USD`,
        });
        if (r.duplicate) {
          console.log("[ls-webhook] order_created duplicate (already granted)", orderId);
        } else {
          console.log(
            "[ls-webhook] credit granted",
            { userId, orderId, creditCents, newBalance: r.balanceCents }
          );
        }
      } catch (err) {
        console.error("[ls-webhook] credit grant failed", err);
      }
      return;
    }

    case "order_refunded": {
      // One-time purchase refunded → claw back credits.
      if (!userId) return;
      const orderId = data?.id != null ? String(data.id) : null;
      if (!orderId) return;

      // Find the original purchase by ls_order ref.
      const { rows } = await pgPool.query<{ amount_cents: string }>(
        `SELECT amount_cents FROM user_credit_ledger
          WHERE ref_type = 'ls_order' AND ref_id = $1 AND type = 'purchase'
          LIMIT 1`,
        [orderId]
      );
      if (rows.length === 0) {
        console.warn("[ls-webhook] order_refunded but no prior purchase", orderId);
        return;
      }
      const originalCents = Number(rows[0]!.amount_cents) || 0;
      try {
        // Refund = negative mutation. If current balance < originalCents,
        // clamp to 0 (user already spent some of it — that's their loss, not ours).
        const { fetchBalance } = await import("./credit-grant.js");
        const current = await fetchBalance(userId);
        const clawback = Math.min(current, originalCents);
        if (clawback > 0) {
          await applyCreditMutation({
            userId,
            type: "refund",
            amountCents: -clawback,
            refType: "ls_order",
            refId: orderId,
            note: `refund for order ${orderId}`,
          });
        }
      } catch (err) {
        console.error("[ls-webhook] credit refund clawback failed", err);
      }
      return;
    }

    default:
      // Unknown event — already logged to billing_events for replay.
      return;
  }
}
