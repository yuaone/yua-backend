// src/connectors/oauth/state-store.ts
// Short-lived OAuth state storage keyed by the CSRF state token.
//
// Flow:
//   1. /authorize handler generates state + verifier, stores here with TTL 10min
//   2. Provider redirects back to /callback with the state
//   3. /callback loads + deletes the state in one step (single-use)
//
// Backing store: Redis (ioredis wrapped by db/redis.ts).

import { redisPub } from "../../db/redis";

const TTL_SECONDS = 600; // 10 minutes

export interface OAuthPending {
  userId: number;
  provider: string;
  verifier: string;
  createdAt: number;
}

function keyFor(state: string): string {
  return `connector:oauth:${state}`;
}

export async function putPending(
  state: string,
  pending: OAuthPending,
): Promise<void> {
  await (redisPub as any).set(
    keyFor(state),
    JSON.stringify(pending),
    "EX",
    TTL_SECONDS,
  );
}

/**
 * Load-and-delete. Returns null if expired / already consumed.
 */
export async function takePending(
  state: string,
): Promise<OAuthPending | null> {
  const key = keyFor(state);
  try {
    const raw = await (redisPub as any).get(key);
    if (!raw) return null;
    await (redisPub as any).del(key).catch(() => {});
    return JSON.parse(String(raw)) as OAuthPending;
  } catch (err) {
    console.warn("[oauth-state-store] takePending failed", err);
    return null;
  }
}
