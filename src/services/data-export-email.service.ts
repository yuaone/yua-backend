// 📂 src/services/data-export-email.service.ts
//
// Phase F.3 — "Your YUA data export is ready" email.
//
// Mirrors the shape of `workspace-invite-email.service.ts` and reuses
// the same transport selection logic (SMTP → SendGrid fallback). The
// URL we embed is a JWT-gated deep link back into /settings/privacy —
// the user must be logged in as the request's owner to actually pull
// the file. This file only knows how to SEND the email; all security
// enforcement lives in privacy-router.ts's download handler.

import nodemailer from "nodemailer";

type SendDataExportReadyParams = {
  /** Recipient — must be the user's verified email on file. */
  toEmail: string;
  /** Optional display name for the salutation ("Hi {name}"). */
  userName: string | null;
  /**
   * Deep link to the privacy settings page with `?exportReady={id}`.
   * Caller builds this from `getWebBaseUrl()` + request id.
   */
  downloadUrl: string;
  /** Hard expiry — shown to the user so they know when the link dies. */
  expiresAt: Date;
  /** File size in bytes — shown to the user so they can plan download. */
  fileSizeBytes: number;
  /**
   * Number of times the file can still be downloaded. Shown as
   * "You can download this {N} more times".
   */
  downloadsRemaining: number;
};

type SendDataExportReadyResult = {
  ok: boolean;
  error?: "mailer_not_configured" | "send_failed";
  messageId?: string;
};

/**
 * Copy of `workspace-invite-email.service.ts::getMailerConfig()` so
 * the two services stay decoupled. If you extend this pattern a third
 * time, lift it into `services/mailer-config.ts`.
 */
function getMailerConfig() {
  const {
    SMTP_HOST = "",
    SMTP_PORT = "",
    SMTP_USER = "",
    SMTP_PASS = "",
    DATA_EXPORT_FROM_EMAIL = "",
    SENDGRID_API_KEY = "",
    MAIL_FROM = "",
  } = process.env;

  const sendgridKey = SENDGRID_API_KEY.trim();
  const hasSmtp =
    SMTP_HOST.trim().length > 0 &&
    SMTP_PORT.trim().length > 0 &&
    SMTP_USER.trim().length > 0 &&
    SMTP_PASS.trim().length > 0;

  if (!hasSmtp && sendgridKey) {
    return {
      host: "smtp.sendgrid.net",
      port: 587,
      user: "apikey",
      pass: sendgridKey,
      from: (DATA_EXPORT_FROM_EMAIL || MAIL_FROM).trim(),
    };
  }

  return {
    host: SMTP_HOST.trim(),
    port: Number(SMTP_PORT),
    user: SMTP_USER.trim(),
    pass: SMTP_PASS.trim(),
    from: (DATA_EXPORT_FROM_EMAIL || MAIL_FROM || SMTP_USER).trim(),
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(d: Date): string {
  try {
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return d.toISOString();
  }
}

export async function sendDataExportReadyEmail(
  params: SendDataExportReadyParams,
): Promise<SendDataExportReadyResult> {
  try {
    const cfg = getMailerConfig();
    if (!cfg.host || !cfg.port || !cfg.user || !cfg.pass || !cfg.from) {
      return { ok: false, error: "mailer_not_configured" };
    }

    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });

    const greeting = params.userName?.trim() || "there";
    const subject = "Your YUA data export is ready";
    const sizeStr = formatBytes(params.fileSizeBytes);
    const expiresStr = formatDate(params.expiresAt);

    const text = [
      `Hi ${greeting},`,
      "",
      "Your YUA data export is ready to download.",
      "",
      `File size     : ${sizeStr}`,
      `Valid until   : ${expiresStr}`,
      `Downloads left: ${params.downloadsRemaining}`,
      "",
      "Click the link below to sign in and download:",
      params.downloadUrl,
      "",
      "If you didn't request this, you can safely ignore this email —",
      "the file can only be downloaded by the account it was prepared for.",
      "",
      "— YUA",
    ].join("\n");

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr><td style="background:linear-gradient(135deg,#1a1f36 0%,#2d3561 100%);padding:32px 32px 24px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">YUA</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.7);margin-top:4px;">Your data export is ready</div>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">Hi <strong>${greeting}</strong>,</p>
          <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">Your YUA data export has finished processing and is ready to download.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border:1px solid #e5e7eb;border-radius:12px;margin-bottom:20px;">
            <tr><td style="padding:14px 18px;border-bottom:1px solid #eef0f3;">
              <div style="font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.4px;">File size</div>
              <div style="font-size:15px;color:#1a1f36;font-weight:600;margin-top:2px;">${sizeStr}</div>
            </td></tr>
            <tr><td style="padding:14px 18px;border-bottom:1px solid #eef0f3;">
              <div style="font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.4px;">Valid until</div>
              <div style="font-size:15px;color:#1a1f36;font-weight:600;margin-top:2px;">${expiresStr}</div>
            </td></tr>
            <tr><td style="padding:14px 18px;">
              <div style="font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.4px;">Downloads remaining</div>
              <div style="font-size:15px;color:#1a1f36;font-weight:600;margin-top:2px;">${params.downloadsRemaining}</div>
            </td></tr>
          </table>
          <div style="text-align:center;margin:24px 0 8px;">
            <a href="${params.downloadUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;background:#1a1f36;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;border-radius:10px;">Sign in &amp; download</a>
          </div>
          <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;text-align:center;">
            You'll need to sign in as the account that requested this export. If you didn't request it, you can safely ignore this email — the file can only be downloaded by the owner account.
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;border-top:1px solid #f0f0f3;text-align:center;">
          <p style="margin:0;font-size:11px;color:#9ca3af;">Questions? <a href="mailto:support@yuaone.com" style="color:#3b82f6;text-decoration:none;">support@yuaone.com</a></p>
          <p style="margin:4px 0 0;font-size:11px;color:#d1d5db;">© 2026 YUAONE</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const info = await transporter.sendMail({
      from: `YUA <${cfg.from}>`,
      to: params.toEmail,
      subject,
      text,
      html,
    });

    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error("[DataExportEmail][SEND_FAIL]", e);
    return { ok: false, error: "send_failed" };
  }
}
