// src/routes/billing-ls-router.ts
// LemonSqueezy billing endpoints.
//
// CRITICAL: the webhook endpoint MUST receive the raw request body so HMAC
// verification can be computed over exactly the bytes LS signed. We mount
// express.raw() INLINE on that route so the global express.json() parser
// (registered in server.ts) does not clobber the body for this one path.

import { Router, Request, Response } from "express";
import express from "express";
import { requireFirebaseAuth } from "../middleware/firebase-auth-middleware";
import { handleLemonSqueezyWebhook } from "../billing/lemonsqueezy/webhook-handler";
import { createUserCheckout } from "../billing/lemonsqueezy/checkout";
import { findActiveByUser } from "../billing/lemonsqueezy/subscription-repo";
import { isLemonSqueezyConfigured } from "../billing/lemonsqueezy/client";
import { fetchBalance } from "../billing/lemonsqueezy/credit-grant";

const router = Router();

/* ------------------------------------------------------------------ */
/* Webhook — NO auth, raw body                                         */
/* ------------------------------------------------------------------ */
router.post(
  "/webhook/lemonsqueezy",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req: Request, res: Response) => {
    const signature =
      (req.headers["x-signature"] as string | undefined) ??
      (req.headers["x-signature".toLowerCase()] as string | undefined);

    // express.raw() gives us a Buffer on req.body.
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body ?? "");

    try {
      const result = await handleLemonSqueezyWebhook(rawBody, signature);
      return res.status(result.status).json(result.body);
    } catch (err) {
      console.error("[billing-ls] webhook handler threw", err);
      return res.status(500).json({ error: "internal_error" });
    }
  }
);

/* ------------------------------------------------------------------ */
/* POST /api/billing/checkout — Firebase auth                           */
/* ------------------------------------------------------------------ */
router.post(
  "/checkout",
  requireFirebaseAuth,
  async (req: Request, res: Response) => {
    if (!isLemonSqueezyConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "LS_NOT_CONFIGURED",
        message: "LemonSqueezy billing is not yet available.",
      });
    }

    const user = req.user;
    if (!user?.userId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const plan = req.body?.plan;
    if (plan !== "pro" && plan !== "max") {
      return res
        .status(400)
        .json({ ok: false, error: "invalid_plan", message: "plan must be 'pro' or 'max'" });
    }

    // Duplicate subscription guard — if the user already has an active
    // or past_due subscription, the client should NOT start a fresh checkout.
    // Instead we return a signal that the UI should route to the "change plan"
    // flow (POST /api/billing/change-plan — future endpoint).
    try {
      const existing = await findActiveByUser(user.userId);
      if (existing && existing.status !== "cancelled" && existing.status !== "expired") {
        // Same plan → idempotent success.
        if (existing.planTier === plan) {
          return res.status(409).json({
            ok: false,
            error: "already_subscribed",
            message: `이미 ${plan} 플랜을 사용 중입니다.`,
            currentPlan: existing.planTier,
          });
        }
        // Different plan → tell the client to use the change-plan flow instead.
        return res.status(409).json({
          ok: false,
          error: "subscription_exists",
          message: "기존 구독이 있습니다. 플랜 변경 기능을 사용해주세요.",
          currentPlan: existing.planTier,
          requestedPlan: plan,
        });
      }
    } catch (err) {
      console.warn("[billing-ls] existing sub check failed (non-fatal)", err);
      // Fall through — better to let the user check out than to block on a DB read error.
    }

    // Workspace id is optional — express.d.ts stores it as a uuid string
    // under req.workspace.id. For the billing join we want the numeric
    // MySQL/PG id if the auth layer populated it, otherwise null.
    const workspaceIdCached = (user as any).workspaceIdCached;
    const workspaceId =
      typeof workspaceIdCached === "number" && Number.isFinite(workspaceIdCached)
        ? workspaceIdCached
        : null;

    try {
      const { url } = await createUserCheckout({
        userId: user.userId,
        workspaceId,
        email: user.email ?? "",
        plan,
      });
      return res.json({ ok: true, url });
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (msg === "LS_NOT_CONFIGURED") {
        return res.status(503).json({ ok: false, error: "LS_NOT_CONFIGURED" });
      }
      console.error("[billing-ls] checkout failed", err);
      return res.status(500).json({
        ok: false,
        error: "checkout_failed",
        message: msg || "unknown",
      });
    }
  }
);

/* ------------------------------------------------------------------ */
/* GET /api/billing/subscription — Firebase auth                        */
/* ------------------------------------------------------------------ */
router.get(
  "/subscription",
  requireFirebaseAuth,
  async (req: Request, res: Response) => {
    const user = req.user;
    if (!user?.userId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    try {
      const sub = await findActiveByUser(user.userId);
      if (!sub) {
        return res.json({
          ok: true,
          plan: "free",
          status: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          updateUrl: null,
          cancelUrl: null,
        });
      }
      return res.json({
        ok: true,
        plan: sub.planTier,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        updateUrl: sub.updateUrl,
        cancelUrl: sub.cancelUrl,
      });
    } catch (err) {
      console.error("[billing-ls] subscription query failed", err);
      return res.status(500).json({ ok: false, error: "db_error" });
    }
  }
);

/* ------------------------------------------------------------------ */
/* GET /api/billing/credits — current balance + recent ledger rows      */
/* ------------------------------------------------------------------ */
router.get(
  "/credits",
  requireFirebaseAuth,
  async (req: Request, res: Response) => {
    const user = req.user;
    if (!user?.userId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    try {
      const balanceCents = await fetchBalance(user.userId);

      // Recent 20 ledger entries for the UI "최근 거래" list.
      const { pgPool: pool } = await import("../db/postgres.js");
      const { rows } = await pool.query(
        `SELECT id, type, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at
           FROM user_credit_ledger
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 20`,
        [user.userId]
      );

      return res.json({
        ok: true,
        balanceUsdCents: balanceCents,
        balanceUsd: balanceCents / 100,
        recentLedger: rows.map((r: any) => ({
          id: Number(r.id),
          type: String(r.type),
          amountCents: Number(r.amount_cents),
          balanceAfterCents: Number(r.balance_after_cents),
          refType: r.ref_type ?? null,
          refId: r.ref_id ?? null,
          note: r.note ?? null,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      });
    } catch (err) {
      console.error("[billing-ls] credits query failed", err);
      return res.status(500).json({ ok: false, error: "db_error" });
    }
  }
);

/* ------------------------------------------------------------------ */
/* POST /api/billing/credits/checkout — create LS checkout for credit pack */
/* ------------------------------------------------------------------ */
router.post(
  "/credits/checkout",
  requireFirebaseAuth,
  async (req: Request, res: Response) => {
    const user = req.user;
    if (!user?.userId) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const pack = String(req.body?.pack ?? "");
    const VALID_PACKS = ["10", "25", "50", "100"] as const;
    if (!VALID_PACKS.includes(pack as any)) {
      return res
        .status(400)
        .json({ ok: false, error: "invalid_pack", message: "pack must be one of 10/25/50/100" });
    }

    const envKey = `LEMONSQUEEZY_CREDITS_${pack}_VARIANT_ID`;
    const variantId = (process.env[envKey] ?? "").trim();
    if (!variantId || variantId === "xx") {
      return res
        .status(503)
        .json({ ok: false, error: "CREDITS_PACK_NOT_CONFIGURED", envKey });
    }

    // Reuse the createCheckout helper but with the credit variant id.
    // We can't call createUserCheckout() which is plan-scoped; inline here.
    try {
      const {
        lemonSqueezySetup,
        createCheckout,
      } = await import("@lemonsqueezy/lemonsqueezy.js");
      lemonSqueezySetup({
        apiKey: process.env.LEMONSQUEEZY_API_KEY ?? "",
      });
      const storeId = (process.env.LEMONSQUEEZY_STORE_ID ?? "").trim();
      if (!storeId || storeId === "xx") {
        return res.status(503).json({ ok: false, error: "LS_NOT_CONFIGURED" });
      }

      const redirectBase = (process.env.YUA_PUBLIC_URL ?? "https://yuaone.com").replace(/\/$/, "");
      const result = await createCheckout(storeId, variantId, {
        checkoutData: {
          email: user.email ?? "",
          custom: {
            userId: String(user.userId),
            kind: "credit_pack",
            pack,
          } as any,
        },
        productOptions: {
          redirectUrl: `${redirectBase}/settings/usage?credit_purchased=1`,
          receiptButtonText: "YUA로 돌아가기",
        },
        checkoutOptions: {
          // Full-page checkout (CSP blocks overlay — see audit C3).
          embed: false,
          dark: true,
          logo: true,
        },
      });

      const url = (result as any)?.data?.data?.attributes?.url;
      if (!url) {
        console.error("[billing-ls] credits checkout no url", result);
        return res.status(500).json({ ok: false, error: "no_checkout_url" });
      }
      return res.json({ ok: true, url });
    } catch (err: any) {
      console.error("[billing-ls] credits checkout failed", err);
      return res.status(500).json({
        ok: false,
        error: "checkout_failed",
        message: String(err?.message ?? "unknown"),
      });
    }
  }
);

export default router;
