// 📂 src/services/magic-link.service.ts
// 🔒 매직링크 이메일 발송 + 검증 — SendGrid SMTP

import nodemailer from "nodemailer";
import crypto from "crypto";
import { pgPool } from "../db/postgres";

const LINK_EXPIRY_MINUTES = 10;
const CODE_LENGTH = 6;
/** Minimum delay between consecutive magic-link sends for the same email. */
const RESEND_THROTTLE_SECONDS = 30;

/* =========================
   이메일 발송
========================= */

function getTransporter() {
  const key = (process.env.SENDGRID_API_KEY ?? "").trim();
  const from = (process.env.MAIL_FROM ?? "noreply@yuaone.com").trim();
  if (!key) throw new Error("SENDGRID_API_KEY not set");

  const transport = nodemailer.createTransport({
    host: "smtp.sendgrid.net",
    port: 587,
    auth: { user: "apikey", pass: key },
  });

  return { transport, from };
}

/* =========================
   매직링크 생성 + 발송
========================= */

export async function sendMagicLink(
  email: string
): Promise<{ ok: boolean; error?: string; throttled?: boolean; retryInSeconds?: number }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return { ok: false, error: "invalid_email" };
  }

  // Throttle: if a code was sent in the last RESEND_THROTTLE_SECONDS,
  // treat the new request as a silent no-op so the existing code stays valid.
  // The client sees `ok: true, throttled: true` and the user's prior email
  // remains the single source of truth until the window elapses.
  const existing = await pgPool.query<{ created_at: Date }>(
    `SELECT created_at FROM auth_magic_links WHERE email = $1`,
    [normalized]
  );
  if (existing.rows.length > 0) {
    const createdAt = existing.rows[0].created_at;
    const elapsedMs = Date.now() - new Date(createdAt).getTime();
    if (elapsedMs < RESEND_THROTTLE_SECONDS * 1000) {
      const retryInSeconds = Math.max(
        1,
        Math.ceil((RESEND_THROTTLE_SECONDS * 1000 - elapsedMs) / 1000)
      );
      return { ok: true, throttled: true, retryInSeconds };
    }
  }

  // 6자리 숫자 코드 생성
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + LINK_EXPIRY_MINUTES * 60 * 1000);

  // DB 저장 (기존 코드 덮어쓰기)
  await pgPool.query(
    `INSERT INTO auth_magic_links (email, code_hash, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       attempts = 0,
       created_at = NOW()`,
    [normalized, codeHash, expiresAt]
  );

  // 이메일 발송
  try {
    const { transport, from } = getTransporter();
    await transport.sendMail({
      from: `YUA <${from}>`,
      to: normalized,
      subject: `YUA 로그인 코드`,
      text: `YUA 로그인 코드는 ${code} 입니다.\n${LINK_EXPIRY_MINUTES}분 내에 입력해주세요.\n이 요청을 하지 않았다면 이 이메일을 무시해주세요.`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1a1f36 0%,#2d3561 100%);padding:32px 32px 24px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">YUA</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:4px;">로그인을 도와드리겠습니다</div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          <p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6;">아래 보안 코드를 입력하여 로그인해주세요.</p>
          <!-- Code Box -->
          <div style="margin:24px 0;padding:20px;background:#f8f9fb;border:1px solid #e5e7eb;border-radius:12px;text-align:center;">
            <div style="font-size:36px;font-weight:700;letter-spacing:10px;color:#1a1f36;font-family:'SF Mono',Consolas,monospace;">${code}</div>
          </div>
          <p style="margin:0 0 4px;font-size:13px;color:#9ca3af;">이 코드는 ${LINK_EXPIRY_MINUTES}분간 유효합니다.</p>
          <p style="margin:0;font-size:13px;color:#9ca3af;">이 이메일을 요청하지 않으셨다면 안전하게 무시하셔도 됩니다.</p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:16px 32px 24px;border-top:1px solid #f0f0f3;text-align:center;">
          <p style="margin:0;font-size:11px;color:#9ca3af;">문제가 발생하시면 <a href="mailto:support@yuaone.com" style="color:#3b82f6;text-decoration:none;">YUA 지원팀</a>에 문의하세요.</p>
          <p style="margin:4px 0 0;font-size:11px;color:#d1d5db;">© 2026 YUAONE</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
    return { ok: true };
  } catch (e) {
    console.error("[MAGIC_LINK][SEND_FAILED]", e);
    return { ok: false, error: "send_failed" };
  }
}

/* =========================
   코드 검증
========================= */

export async function verifyMagicCode(
  email: string,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  const normalized = email.trim().toLowerCase();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");

  // 🔒 트랜잭션 + FOR UPDATE (TOCTOU race condition 방지)
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT code_hash, expires_at, attempts FROM auth_magic_links
       WHERE email = $1 FOR UPDATE`,
      [normalized]
    );

    // 🔒 통합 에러 (이메일 열거 방지)
    if (rows.length === 0 || new Date(rows[0].expires_at) < new Date() || Number(rows[0].attempts) >= 5) {
      await client.query("ROLLBACK");
      return { ok: false, error: "invalid_or_expired" };
    }

    // 시도 횟수 증가
    await client.query(
      `UPDATE auth_magic_links SET attempts = attempts + 1 WHERE email = $1`,
      [normalized]
    );

    // 🔒 timing-safe 비교
    const storedBuf = Buffer.from(rows[0].code_hash, "hex");
    const inputBuf = Buffer.from(codeHash, "hex");
    if (storedBuf.length !== inputBuf.length || !crypto.timingSafeEqual(storedBuf, inputBuf)) {
      await client.query("COMMIT");
      return { ok: false, error: "invalid_or_expired" };
    }

    // 성공 — 코드 삭제
    await client.query(`DELETE FROM auth_magic_links WHERE email = $1`, [normalized]);
    await client.query("COMMIT");

    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
