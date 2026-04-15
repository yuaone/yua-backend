import { Router, Request, Response } from "express";
import {
  acknowledgeProductPurchase,
  acknowledgeSubscriptionPurchase,
  consumeProductPurchase,
  extractSubscriptionProductId,
  listVoidedPurchases,
  verifyProductPurchase,
  verifySubscriptionPurchase,
} from "../billing/play-billing-service";
import {
  revokeGooglePlayPurchaseByToken,
  upsertGooglePlayPurchase,
} from "../billing/play-billing-repo";
import { pgPool } from "../db/postgres";

const router = Router();
const PLAY_PRO_PRODUCTS = new Set(["yua_pro_monthly"]);

type BillingVerificationLogInput = {
  platform?: string | null;
  provider?: string | null;
  productType?: string | null;
  productId?: string | null;
  orderId?: string | null;
  purchaseToken?: string | null;
  userId?: number | null;
  workspaceId?: string | number | null;
  verificationStatus: string;
  reasonCode?: string | null;
  latencyMs?: number | null;
  rawRequest?: unknown;
  rawResponse?: unknown;
  idempotencyKey?: string | null;
};

async function writeBillingVerificationLog(input: BillingVerificationLogInput): Promise<void> {
  try {
    const ws = input.workspaceId == null ? null : Number(input.workspaceId);
    await pgPool.query(
      `
      INSERT INTO billing_verification_log (
        platform, provider, product_type, product_id, order_id, purchase_token,
        user_id, workspace_id, verification_status, reason_code, latency_ms,
        raw_request, raw_response, idempotency_key
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12::jsonb, $13::jsonb, $14
      )
      `,
      [
        input.platform ?? "mobile",
        input.provider ?? "google_play",
        input.productType ?? null,
        input.productId ?? null,
        input.orderId ?? null,
        input.purchaseToken ?? null,
        input.userId ?? null,
        Number.isFinite(ws) ? ws : null,
        input.verificationStatus,
        input.reasonCode ?? null,
        input.latencyMs ?? null,
        JSON.stringify(input.rawRequest ?? {}),
        JSON.stringify(input.rawResponse ?? {}),
        input.idempotencyKey ?? null,
      ]
    );
  } catch {
    // billing verification log failure must not break request path
  }
}

function getWorkspaceId(req: any): string | null {
  const ws = req.workspace?.id;
  return ws ? String(ws) : null;
}

function getUserId(req: any): number | null {
  const raw = req.user?.id ?? req.user?.userId;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function canManageBilling(req: any): boolean {
  const role = String(req.workspace?.role ?? "");
  return role === "owner" || role === "admin";
}

function getInternalToken(req: Request): string {
  const raw = req.headers["x-internal-token"];
  return typeof raw === "string" ? raw : "";
}

function requireInternalAccess(req: Request, res: Response): boolean {
  const expected = process.env.INTERNAL_SERVICE_TOKEN ?? "";
  if (!expected || getInternalToken(req) !== expected) {
    res.status(403).json({ ok: false, error: "internal_access_required" });
    return false;
  }
  return true;
}

async function applyWorkspaceTierFromPlayPurchase(
  workspaceId: string,
  productId: string,
  entitled: boolean
) {
  const tier = entitled && PLAY_PRO_PRODUCTS.has(productId) ? "pro" : "free";
  await pgPool.query(
    `
    INSERT INTO workspace_plan_state (workspace_id, tier, status, source)
    VALUES ($1, $2, 'active', $3)
    ON CONFLICT (workspace_id)
    DO UPDATE SET
      tier = EXCLUDED.tier,
      status = 'active',
      source = EXCLUDED.source,
      updated_at = now()
    `,
    [workspaceId, tier, entitled ? "google_play" : "google_play_revoke"]
  );
}

router.post("/play/verify-subscription", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const workspaceId = getWorkspaceId(req);
    const userId = getUserId(req);
    if (!workspaceId) return res.status(400).json({ ok: false, error: "workspace_required" });
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

    const { purchaseToken, packageName } = req.body ?? {};
    const result = await verifySubscriptionPurchase({ purchaseToken, packageName });
    await writeBillingVerificationLog({
      platform: "mobile",
      provider: "google_play",
      productType: "subscription",
      productId: extractSubscriptionProductId(result.purchase),
      orderId: result.purchase.latestOrderId ?? null,
      purchaseToken: result.purchaseToken,
      userId,
      workspaceId,
      verificationStatus: result.entitlement.hasAccess ? "verified" : "denied",
      reasonCode: result.entitlement.state ?? null,
      latencyMs: Date.now() - startedAt,
      rawRequest: req.body ?? {},
      rawResponse: result,
      idempotencyKey: null,
    });
    return res.json({ ok: true, workspaceId, userId, ...result });
  } catch (err: any) {
    await writeBillingVerificationLog({
      platform: "mobile",
      provider: "google_play",
      productType: "subscription",
      productId: null,
      orderId: null,
      purchaseToken: req.body?.purchaseToken ?? null,
      userId: getUserId(req),
      workspaceId: getWorkspaceId(req),
      verificationStatus: "failed",
      reasonCode: err?.message || "play_verify_failed",
      latencyMs: Date.now() - startedAt,
      rawRequest: req.body ?? {},
      rawResponse: { error: err?.message || "play_verify_failed" },
      idempotencyKey: null,
    });
    return res.status(500).json({ ok: false, error: err?.message || "play_verify_failed" });
  }
});

router.post("/play/sync-subscription", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const workspaceId = getWorkspaceId(req);
    const userId = getUserId(req);
    if (!workspaceId) return res.status(400).json({ ok: false, error: "workspace_required" });
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!canManageBilling(req)) return res.status(403).json({ ok: false, error: "billing_admin_required" });

    const { purchaseToken, packageName } = req.body ?? {};
    const result = await verifySubscriptionPurchase({ purchaseToken, packageName });
    const productId = extractSubscriptionProductId(result.purchase);
    if (!productId) {
      return res.status(400).json({ ok: false, error: "subscription_product_id_missing" });
    }

    let acknowledged = !result.needsAcknowledgement;
    if (result.needsAcknowledgement && result.entitlement.hasAccess) {
      await acknowledgeSubscriptionPurchase({
        purchaseToken: result.purchaseToken,
        packageName: result.packageName,
        subscriptionId: productId,
      });
      acknowledged = true;
    }

    const latestExpiry =
      result.purchase.lineItems?.reduce<string | null>((latest, item) => {
        if (!item.expiryTime) return latest;
        if (!latest) return item.expiryTime;
        return Date.parse(item.expiryTime) > Date.parse(latest) ? item.expiryTime : latest;
      }, null) ?? null;

    const row = await upsertGooglePlayPurchase({
      workspaceId,
      userId,
      productType: "subscription",
      productId,
      purchaseToken: result.purchaseToken,
      orderId: result.purchase.latestOrderId ?? null,
      entitlementStatus: result.entitlement.hasAccess ? "active" : "revoked",
      purchaseState: result.entitlement.state,
      expiryTime: latestExpiry,
      acknowledged,
      revoked: result.entitlement.shouldRevoke,
      rawPayload: result.purchase,
    });

    await applyWorkspaceTierFromPlayPurchase(
      workspaceId,
      productId,
      result.entitlement.hasAccess
    );

    await writeBillingVerificationLog({
      platform: "mobile",
      provider: "google_play",
      productType: "subscription",
      productId,
      orderId: result.purchase.latestOrderId ?? null,
      purchaseToken: result.purchaseToken,
      userId,
      workspaceId,
      verificationStatus: result.entitlement.hasAccess ? "verified" : "denied",
      reasonCode: result.entitlement.state ?? null,
      latencyMs: Date.now() - startedAt,
      rawRequest: req.body ?? {},
      rawResponse: result,
      idempotencyKey: null,
    });

    return res.json({ ok: true, sync: row, verification: result });
  } catch (err: any) {
    await writeBillingVerificationLog({
      platform: "mobile",
      provider: "google_play",
      productType: "subscription",
      productId: req.body?.productId ?? null,
      orderId: null,
      purchaseToken: req.body?.purchaseToken ?? null,
      userId: getUserId(req),
      workspaceId: getWorkspaceId(req),
      verificationStatus: "failed",
      reasonCode: err?.message || "play_sync_failed",
      latencyMs: Date.now() - startedAt,
      rawRequest: req.body ?? {},
      rawResponse: { error: err?.message || "play_sync_failed" },
      idempotencyKey: null,
    });
    return res.status(500).json({ ok: false, error: err?.message || "play_sync_failed" });
  }
});

router.post("/play/verify-product", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const workspaceId = getWorkspaceId(req);
    const userId = getUserId(req);
    if (!workspaceId) return res.status(400).json({ ok: false, error: "workspace_required" });
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

    const { productId, purchaseToken, packageName } = req.body ?? {};
    const result = await verifyProductPurchase({ productId, purchaseToken, packageName });
    await writeBillingVerificationLog({
      platform: "mobile",
      provider: "google_play",
      productType: "product",
      productId: result.productId,
      orderId: result.purchase.orderId ?? null,
      purchaseToken: result.purchaseToken,
      userId,
      workspaceId,
      verificationStatus: result.entitlement.hasAccess ? "verified" : "denied",
      reasonCode: String(result.entitlement.purchaseState),
      latencyMs: Date.now() - startedAt,
      rawRequest: req.body ?? {},
      rawResponse: result,
      idempotencyKey: null,
    });
    return res.json({ ok: true, workspaceId, userId, ...result });
  } catch (err: any) {
    await writeBillingVerificationLog({
      platform: "mobile",
      provider: "google_play",
      productType: "product",
      productId: req.body?.productId ?? null,
      orderId: null,
      purchaseToken: req.body?.purchaseToken ?? null,
      userId: getUserId(req),
      workspaceId: getWorkspaceId(req),
      verificationStatus: "failed",
      reasonCode: err?.message || "play_verify_failed",
      latencyMs: Date.now() - startedAt,
      rawRequest: req.body ?? {},
      rawResponse: { error: err?.message || "play_verify_failed" },
      idempotencyKey: null,
    });
    return res.status(500).json({ ok: false, error: err?.message || "play_verify_failed" });
  }
});

router.post("/play/sync-product", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const workspaceId = getWorkspaceId(req);
    const userId = getUserId(req);
    if (!workspaceId) return res.status(400).json({ ok: false, error: "workspace_required" });
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!canManageBilling(req)) return res.status(403).json({ ok: false, error: "billing_admin_required" });

    const { productId, purchaseToken, packageName, consumable } = req.body ?? {};
    const result = await verifyProductPurchase({ productId, purchaseToken, packageName });

    let acknowledged = !result.needsAcknowledgement;
    if (result.needsAcknowledgement && result.entitlement.hasAccess && !consumable) {
      await acknowledgeProductPurchase({ productId, purchaseToken, packageName });
      acknowledged = true;
    }
    if (result.needsConsumption && result.entitlement.hasAccess && consumable) {
      await consumeProductPurchase({ productId, purchaseToken, packageName });
      acknowledged = true;
    }

    const row = await upsertGooglePlayPurchase({
      workspaceId,
      userId,
      productType: "product",
      productId,
      purchaseToken,
      orderId: result.purchase.orderId ?? null,
      entitlementStatus: result.entitlement.hasAccess ? "active" : "revoked",
      purchaseState: String(result.entitlement.purchaseState),
      expiryTime: null,
      acknowledged,
      revoked: result.entitlement.shouldRevoke,
      rawPayload: result.purchase,
    });

    await writeBillingVerificationLog({
      platform: "mobile",
      provider: "google_play",
      productType: "product",
      productId,
      orderId: result.purchase.orderId ?? null,
      purchaseToken,
      userId,
      workspaceId,
      verificationStatus: result.entitlement.hasAccess ? "verified" : "denied",
      reasonCode: String(result.entitlement.purchaseState),
      latencyMs: Date.now() - startedAt,
      rawRequest: req.body ?? {},
      rawResponse: result,
      idempotencyKey: null,
    });

    return res.json({ ok: true, sync: row, verification: result });
  } catch (err: any) {
    await writeBillingVerificationLog({
      platform: "mobile",
      provider: "google_play",
      productType: "product",
      productId: req.body?.productId ?? null,
      orderId: null,
      purchaseToken: req.body?.purchaseToken ?? null,
      userId: getUserId(req),
      workspaceId: getWorkspaceId(req),
      verificationStatus: "failed",
      reasonCode: err?.message || "play_sync_failed",
      latencyMs: Date.now() - startedAt,
      rawRequest: req.body ?? {},
      rawResponse: { error: err?.message || "play_sync_failed" },
      idempotencyKey: null,
    });
    return res.status(500).json({ ok: false, error: err?.message || "play_sync_failed" });
  }
});

router.post("/play/acknowledge-subscription", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!canManageBilling(req)) return res.status(403).json({ ok: false, error: "billing_admin_required" });

    const { purchaseToken, packageName, subscriptionId, developerPayload } = req.body ?? {};
    if (!subscriptionId) {
      return res.status(400).json({ ok: false, error: "subscription_id_required" });
    }
    await acknowledgeSubscriptionPurchase({
      purchaseToken,
      packageName,
      subscriptionId,
      developerPayload,
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "play_ack_failed" });
  }
});

router.post("/play/acknowledge-product", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!canManageBilling(req)) return res.status(403).json({ ok: false, error: "billing_admin_required" });

    const { productId, purchaseToken, packageName, developerPayload, consumable } = req.body ?? {};
    if (consumable) {
      await consumeProductPurchase({ productId, purchaseToken, packageName });
    } else {
      await acknowledgeProductPurchase({
        productId,
        purchaseToken,
        packageName,
        developerPayload,
      });
    }
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "play_ack_failed" });
  }
});

router.get("/play/voided", async (req: Request, res: Response) => {
  try {
    if (!requireInternalAccess(req, res)) return;

    const startTimeMillis = req.query.startTime
      ? Number(req.query.startTime)
      : Date.now() - 7 * 24 * 60 * 60 * 1000;
    const endTimeMillis = req.query.endTime ? Number(req.query.endTime) : undefined;
    const type = req.query.type !== undefined ? Number(req.query.type) as 0 | 1 : undefined;
    const maxResults = req.query.maxResults ? Number(req.query.maxResults) : 100;
    const token = typeof req.query.token === "string" ? req.query.token : undefined;

    const result = await listVoidedPurchases({
      startTimeMillis,
      endTimeMillis,
      type,
      maxResults,
      token,
    });

    return res.json({ ok: true, data: result });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "play_voided_failed" });
  }
});

router.post("/play/reconcile-voided", async (req: Request, res: Response) => {
  try {
    if (!requireInternalAccess(req, res)) return;

    const result = await listVoidedPurchases({
      startTimeMillis:
        typeof req.body?.startTimeMillis === "number"
          ? req.body.startTimeMillis
          : Date.now() - 7 * 24 * 60 * 60 * 1000,
      endTimeMillis:
        typeof req.body?.endTimeMillis === "number" ? req.body.endTimeMillis : undefined,
      maxResults:
        typeof req.body?.maxResults === "number" ? req.body.maxResults : 100,
      token: typeof req.body?.token === "string" ? req.body.token : undefined,
    });

    const purchases = Array.isArray((result as any)?.voidedPurchases)
      ? (result as any).voidedPurchases
      : [];

    const revoked: string[] = [];
    for (const item of purchases) {
      const token = typeof item?.purchaseToken === "string" ? item.purchaseToken : "";
      if (!token) continue;
      const row = await revokeGooglePlayPurchaseByToken(token);
      if (row?.workspace_id && row?.product_id) {
        await applyWorkspaceTierFromPlayPurchase(row.workspace_id, row.product_id, false);
        revoked.push(token);
      }
    }

    return res.json({ ok: true, revokedCount: revoked.length, nextPageToken: (result as any)?.token ?? null });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "play_reconcile_failed" });
  }
});

export default router;
