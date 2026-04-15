// 📂 src/connectors/interest-repo.ts
// Phase 1 — Interest capture repository for connectors.
// Real OAuth runtime (user_connectors table) lands in Phase 2.

import { pgPool } from "../db/postgres";
import {
  CONNECTOR_CATALOG,
  type ConnectorProvider,
} from "yua-shared";

export interface InterestRow {
  userId: number;
  provider: ConnectorProvider;
  createdAt: string;
}

/** Throw if the caller passes a provider id that is not in the SSOT catalog. */
function assertKnownProvider(provider: string): asserts provider is ConnectorProvider {
  if (!Object.prototype.hasOwnProperty.call(CONNECTOR_CATALOG, provider)) {
    throw new Error("UNKNOWN_PROVIDER");
  }
}

/**
 * Record that `userId` wants to be notified when `provider` ships.
 * Idempotent: re-clicking "알림 받기" is a no-op on conflict.
 */
export async function registerInterest(
  userId: number,
  provider: ConnectorProvider,
): Promise<void> {
  assertKnownProvider(provider);
  await pgPool.query(
    `INSERT INTO user_connector_interest (user_id, provider)
     VALUES ($1, $2)
     ON CONFLICT (user_id, provider) DO NOTHING`,
    [userId, provider],
  );
}

/**
 * Remove interest registration for `userId` × `provider`.
 * Idempotent: deleting a non-existent row is fine.
 */
export async function unregisterInterest(
  userId: number,
  provider: ConnectorProvider,
): Promise<void> {
  assertKnownProvider(provider);
  await pgPool.query(
    `DELETE FROM user_connector_interest
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
}

/** List every provider this user has registered interest in. */
export async function listInterestsForUser(
  userId: number,
): Promise<ConnectorProvider[]> {
  const result = await pgPool.query<{ provider: string }>(
    `SELECT provider FROM user_connector_interest WHERE user_id = $1`,
    [userId],
  );
  const out: ConnectorProvider[] = [];
  for (const row of result.rows) {
    // Defensive filter: drop any stray rows that predate the current catalog.
    if (Object.prototype.hasOwnProperty.call(CONNECTOR_CATALOG, row.provider)) {
      out.push(row.provider as ConnectorProvider);
    }
  }
  return out;
}

/**
 * Aggregate interest counts across all providers in CONNECTOR_CATALOG.
 * Every catalog entry is present in the result (0 if no rows exist).
 */
export async function countInterestsByProvider(): Promise<Record<ConnectorProvider, number>> {
  const result = await pgPool.query<{ provider: string; count: string }>(
    `SELECT provider, COUNT(*)::bigint AS count
     FROM user_connector_interest
     GROUP BY provider`,
  );

  // Seed every known provider with 0 so the shape is stable for the client.
  const counts = {} as Record<ConnectorProvider, number>;
  for (const key of Object.keys(CONNECTOR_CATALOG) as ConnectorProvider[]) {
    counts[key] = 0;
  }
  for (const row of result.rows) {
    if (Object.prototype.hasOwnProperty.call(CONNECTOR_CATALOG, row.provider)) {
      const n = Number(row.count);
      counts[row.provider as ConnectorProvider] = Number.isFinite(n) ? n : 0;
    }
  }
  return counts;
}
