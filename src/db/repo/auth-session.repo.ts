// 📂 src/db/repo/auth-session.repo.ts
// 🔒 세션 저장소 — httpOnly cookie refresh token 관리

import { pgPool } from "../postgres";

export interface AuthSession {
  id: string;       // UUID
  user_id: number;
  token_hash: string;
  device_info: Record<string, unknown> | null;
  expires_at: Date;
  created_at: Date;
}

const SESSION_DURATION_DAYS = 7;

export const AuthSessionRepo = {
  /** 세션 생성 */
  async create(
    userId: number,
    tokenHash: string,
    deviceInfo?: Record<string, unknown>
  ): Promise<string> {
    const { rows } = await pgPool.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, token_hash, device_info, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${SESSION_DURATION_DAYS} days')
       RETURNING id`,
      [userId, tokenHash, deviceInfo ?? null]
    );
    return rows[0].id;
  },

  /** token_hash로 세션 조회 */
  async findByTokenHash(hash: string): Promise<AuthSession | null> {
    const { rows } = await pgPool.query<AuthSession>(
      `SELECT * FROM auth_sessions
       WHERE token_hash = $1 AND expires_at > NOW()`,
      [hash]
    );
    return rows[0] ?? null;
  },

  /** 세션 삭제 (로그아웃) */
  async deleteByTokenHash(hash: string): Promise<void> {
    await pgPool.query(
      `DELETE FROM auth_sessions WHERE token_hash = $1`,
      [hash]
    );
  },

  /** 유저 전체 세션 삭제 (전체 로그아웃) */
  async deleteAllByUser(userId: number): Promise<void> {
    await pgPool.query(
      `DELETE FROM auth_sessions WHERE user_id = $1`,
      [userId]
    );
  },

  /** 만료 세션 정리 (크론) */
  async deleteExpired(): Promise<number> {
    const { rowCount } = await pgPool.query(
      `DELETE FROM auth_sessions WHERE expires_at < NOW()`
    );
    return rowCount ?? 0;
  },

  /** 토큰 rotation — 이전 삭제 + 새로 생성 */
  async rotate(
    oldHash: string,
    newHash: string,
    userId: number,
    deviceInfo?: Record<string, unknown>
  ): Promise<string | null> {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM auth_sessions WHERE token_hash = $1`,
        [oldHash]
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO auth_sessions (user_id, token_hash, device_info, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${SESSION_DURATION_DAYS} days')
         RETURNING id`,
        [userId, newHash, deviceInfo ?? null]
      );
      await client.query("COMMIT");
      return rows[0]?.id ?? null;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
};
