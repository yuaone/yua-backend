import nodemailer from "nodemailer";

export type SendSupportAutoReplyParams = {
  toEmail: string;
  ticketId: number;
  subject: string;
  bodyText: string;
};

export type SendSupportAutoReplyResult = {
  ok: boolean;
  messageId?: string;
  error?: "mailer_not_configured" | "send_failed";
};

function getMailerConfig() {
  const {
    SMTP_HOST = "",
    SMTP_PORT = "",
    SMTP_USER = "",
    SMTP_PASS = "",
    SENDGRID_API_KEY = "",
    SUPPORT_MAIL_FROM = "",
    MAIL_FROM = "",
  } = process.env;

  const smtpHost = SMTP_HOST.trim();
  const smtpPort = SMTP_PORT.trim();
  const smtpUser = SMTP_USER.trim();
  const smtpPass = SMTP_PASS.trim();
  const sendgridKey = SENDGRID_API_KEY.trim();
  const from = (SUPPORT_MAIL_FROM || MAIL_FROM || SMTP_USER).trim();

  if (!smtpHost && !smtpPort && !smtpUser && !smtpPass && sendgridKey) {
    return {
      host: "smtp.sendgrid.net",
      port: 587,
      user: "apikey",
      pass: sendgridKey,
      from,
    };
  }

  return {
    host: smtpHost,
    port: Number(smtpPort || 0),
    user: smtpUser,
    pass: smtpPass,
    from,
  };
}

export async function sendSupportAutoReplyEmail(
  params: SendSupportAutoReplyParams
): Promise<SendSupportAutoReplyResult> {
  try {
    const cfg = getMailerConfig();
    if (!cfg.host || !cfg.port || !cfg.user || !cfg.pass || !cfg.from) {
      return { ok: false, error: "mailer_not_configured" };
    }

    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: {
        user: cfg.user,
        pass: cfg.pass,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });

    const subject = `[YUA Support] ${params.subject} #TICKET-${params.ticketId}`;
    const text = [
      "안녕하세요. YUA SupportAI입니다.",
      "",
      params.bodyText.trim(),
      "",
      `문의번호: #TICKET-${params.ticketId}`,
      "추가 정보가 필요하면 이 메일에 회신해 주세요.",
    ].join("\n");

    const html = [
      "<p>안녕하세요. <strong>YUA SupportAI</strong>입니다.</p>",
      `<p>${escapeHtml(params.bodyText).replace(/\n/g, "<br/>")}</p>`,
      `<p style="margin-top:16px;color:#6b7280;">문의번호: <strong>#TICKET-${params.ticketId}</strong></p>`,
      '<p style="color:#6b7280;">추가 정보가 필요하면 이 메일에 회신해 주세요.</p>',
    ].join("");

    const info = await transporter.sendMail({
      from: cfg.from,
      to: params.toEmail,
      subject,
      text,
      html,
    });

    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error("[SupportEmail][SEND_FAIL]", e);
    return { ok: false, error: "send_failed" };
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
