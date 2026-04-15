import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import fetch, { type RequestInit } from "node-fetch";

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

type ProductPurchaseResponse = {
  purchaseState?: number;
  acknowledgementState?: number;
  consumptionState?: number;
  purchaseToken?: string;
  productId?: string;
  refundableQuantity?: number;
  orderId?: string;
};

type SubscriptionPurchaseV2LineItem = {
  productId?: string;
  expiryTime?: string;
};

type SubscriptionPurchaseV2Response = {
  subscriptionState?: string;
  acknowledgementState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string | null;
  lineItems?: SubscriptionPurchaseV2LineItem[];
};

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function readServiceAccount(): ServiceAccount {
  const rawJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("google_play_service_account_invalid");
    }
    return parsed;
  }

  const filePath = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE?.trim();
  if (!filePath) {
    throw new Error("google_play_service_account_missing");
  }

  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("google_play_service_account_invalid");
  }
  return parsed;
}

function getPackageName(explicitPackageName?: string): string {
  const packageName =
    explicitPackageName?.trim() || process.env.GOOGLE_PLAY_PACKAGE_NAME?.trim();
  if (!packageName) {
    throw new Error("google_play_package_name_missing");
  }
  return packageName;
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const account = readServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    account.private_key,
    { algorithm: "RS256" }
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`google_play_oauth_failed:${res.status}:${text}`);
  }

  const data = (await res.json()) as GoogleTokenResponse;
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, data.expires_in - 120) * 1000,
  };
  return data.access_token;
}

async function googleRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };

  if (init?.headers) {
    const extra = init.headers as any;
    if (Array.isArray(extra)) {
      for (const [key, value] of extra) {
        headers[String(key)] = String(value);
      }
    } else if (typeof extra.forEach === "function") {
      extra.forEach((value: string, key: string) => {
        headers[String(key)] = String(value);
      });
    } else {
      for (const [key, value] of Object.entries(extra)) {
        headers[String(key)] = Array.isArray(value) ? value.join(",") : String(value);
      }
    }
  }

  const requestInit: RequestInit = {
    ...init,
    headers,
  };

  const res = await fetch(url, requestInit);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`google_play_api_failed:${res.status}:${text}`);
  }

  if (res.status === 204) {
    return null as T;
  }

  return (await res.json()) as T;
}

function hasFutureExpiry(lineItems?: SubscriptionPurchaseV2LineItem[]): boolean {
  return Boolean(
    lineItems?.some((item) => {
      if (!item.expiryTime) return false;
      const expiry = Date.parse(item.expiryTime);
      return Number.isFinite(expiry) && expiry > Date.now();
    })
  );
}

export function getSubscriptionEntitlementState(
  purchase: SubscriptionPurchaseV2Response
) {
  const state = purchase.subscriptionState ?? "SUBSCRIPTION_STATE_UNSPECIFIED";
  const hasAccess =
    state === "SUBSCRIPTION_STATE_ACTIVE" ||
    state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" ||
    (state === "SUBSCRIPTION_STATE_CANCELED" && hasFutureExpiry(purchase.lineItems));

  return {
    state,
    hasAccess,
    shouldRevoke:
      state === "SUBSCRIPTION_STATE_ON_HOLD" ||
      state === "SUBSCRIPTION_STATE_EXPIRED" ||
      state === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED" ||
      (state === "SUBSCRIPTION_STATE_CANCELED" && !hasFutureExpiry(purchase.lineItems)),
  };
}

export function getProductEntitlementState(purchase: ProductPurchaseResponse) {
  const purchaseState = Number(purchase.purchaseState ?? -1);
  const hasAccess = purchaseState === 0;
  return {
    purchaseState,
    hasAccess,
    shouldRevoke: purchaseState !== 0,
  };
}

export async function verifySubscriptionPurchase(args: {
  purchaseToken: string;
  packageName?: string;
}) {
  const packageName = getPackageName(args.packageName);
  const token = args.purchaseToken.trim();
  if (!token) throw new Error("purchase_token_missing");

  const data = await googleRequest<SubscriptionPurchaseV2Response>(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      packageName
    )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`
  );

  return {
    packageName,
    purchaseToken: token,
    purchase: data,
    entitlement: getSubscriptionEntitlementState(data),
    needsAcknowledgement:
      data.acknowledgementState !== "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  };
}

export async function verifyProductPurchase(args: {
  productId: string;
  purchaseToken: string;
  packageName?: string;
}) {
  const packageName = getPackageName(args.packageName);
  const productId = args.productId.trim();
  const token = args.purchaseToken.trim();
  if (!productId) throw new Error("product_id_missing");
  if (!token) throw new Error("purchase_token_missing");

  const data = await googleRequest<ProductPurchaseResponse>(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      packageName
    )}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`
  );

  return {
    packageName,
    productId,
    purchaseToken: token,
    purchase: data,
    entitlement: getProductEntitlementState(data),
    needsAcknowledgement: Number(data.acknowledgementState ?? 0) !== 1,
    needsConsumption: Number(data.consumptionState ?? 0) !== 1,
  };
}

export async function acknowledgeSubscriptionPurchase(args: {
  purchaseToken: string;
  packageName?: string;
  subscriptionId: string;
  developerPayload?: string;
}) {
  const packageName = getPackageName(args.packageName);
  const token = args.purchaseToken.trim();
  const subscriptionId = args.subscriptionId.trim();
  if (!token) throw new Error("purchase_token_missing");
  if (!subscriptionId) throw new Error("subscription_id_missing");

  await googleRequest<null>(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      packageName
    )}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(
      token
    )}:acknowledge`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        developerPayload: args.developerPayload ?? undefined,
      }),
    }
  );
}

export async function acknowledgeProductPurchase(args: {
  productId: string;
  purchaseToken: string;
  packageName?: string;
  developerPayload?: string;
}) {
  const packageName = getPackageName(args.packageName);
  const productId = args.productId.trim();
  const token = args.purchaseToken.trim();
  if (!productId) throw new Error("product_id_missing");
  if (!token) throw new Error("purchase_token_missing");

  await googleRequest<null>(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      packageName
    )}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(
      token
    )}:acknowledge`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        developerPayload: args.developerPayload ?? undefined,
      }),
    }
  );
}

export async function consumeProductPurchase(args: {
  productId: string;
  purchaseToken: string;
  packageName?: string;
}) {
  const packageName = getPackageName(args.packageName);
  const productId = args.productId.trim();
  const token = args.purchaseToken.trim();
  if (!productId) throw new Error("product_id_missing");
  if (!token) throw new Error("purchase_token_missing");

  await googleRequest<null>(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      packageName
    )}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(
      token
    )}:consume`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }
  );
}

export async function listVoidedPurchases(args?: {
  packageName?: string;
  startTimeMillis?: number;
  endTimeMillis?: number;
  type?: 0 | 1;
  maxResults?: number;
  token?: string;
}) {
  const packageName = getPackageName(args?.packageName);
  const url = new URL(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      packageName
    )}/purchases/voidedpurchases`
  );

  if (args?.startTimeMillis) url.searchParams.set("startTime", String(args.startTimeMillis));
  if (args?.endTimeMillis) url.searchParams.set("endTime", String(args.endTimeMillis));
  if (typeof args?.type === "number") url.searchParams.set("type", String(args.type));
  if (args?.maxResults) url.searchParams.set("maxResults", String(args.maxResults));
  if (args?.token) url.searchParams.set("token", args.token);

  return googleRequest<any>(url.toString());
}

export function extractSubscriptionProductId(
  purchase: SubscriptionPurchaseV2Response
): string | null {
  return purchase.lineItems?.find((item) => item.productId)?.productId ?? null;
}
