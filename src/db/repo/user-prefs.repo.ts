// 📂 src/db/repo/user-prefs.repo.ts
// User-scoped preference bag backed by JSONB. Whitelist + type coercion
// happens at the controller layer — the repo just stores the blob.
import { pgPool } from "../postgres";

export type UserPrefs = Record<string, unknown>;

export async function getUserPrefs(userId: number): Promise<UserPrefs> {
  const r = await pgPool.query<{ data: UserPrefs }>(
    `SELECT data FROM user_prefs WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!r.rows.length) return {};
  return r.rows[0].data ?? {};
}

export async function mergeUserPrefs(
  userId: number,
  patch: UserPrefs
): Promise<UserPrefs> {
  const r = await pgPool.query<{ data: UserPrefs }>(
    `
    INSERT INTO user_prefs (user_id, data, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      data = COALESCE(user_prefs.data, '{}'::jsonb) || EXCLUDED.data,
      updated_at = NOW()
    RETURNING data
    `,
    [userId, JSON.stringify(patch)]
  );
  return r.rows[0]?.data ?? {};
}
