import nodemailer from "nodemailer";

type SendWorkspaceInviteParams = {
  toEmail: string;
  workspaceName: string;
  inviterName: string | null;
  role: "admin" | "member" | "viewer";
  inviteUrl: string;
  expiresAt: Date | null;
};

type SendWorkspaceInviteResult = {
  ok: boolean;
  error?: "mailer_not_configured" | "send_failed";
  messageId?: string;
};

function getMailerConfig() {
  const {
    SMTP_HOST = "",
    SMTP_PORT = "",
    SMTP_USER = "",
    SMTP_PASS = "",
    INVITE_FROM_EMAIL = "",
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
      from: (INVITE_FROM_EMAIL || MAIL_FROM).trim(),
    };
  }

  return {
    host: SMTP_HOST.trim(),
    port: Number(SMTP_PORT),
    user: SMTP_USER.trim(),
    pass: SMTP_PASS.trim(),
    from: (INVITE_FROM_EMAIL || MAIL_FROM || SMTP_USER).trim(),
  };
}

export async function sendWorkspaceInviteEmail(
  params: SendWorkspaceInviteParams
): Promise<SendWorkspaceInviteResult> {
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
    });

    const inviter = params.inviterName?.trim() || "YUA Team";
    const subject = `[YUA] ${params.workspaceName} 워크스페이스 초대`;
    const expiresText = params.expiresAt
      ? `이 링크는 ${params.expiresAt.toLocaleString()} 까지 유효합니다.`
      : "링크 만료 시간은 워크스페이스 정책에 따릅니다.";

    const text = [
      `${inviter} 님이 ${params.workspaceName} 워크스페이스로 초대했습니다.`,
      `권한: ${params.role}`,
      "",
      `수락 링크: ${params.inviteUrl}`,
      "",
      expiresText,
    ].join("\n");

    const html = [
      `<p><strong>${inviter}</strong> 님이 <strong>${params.workspaceName}</strong> 워크스페이스로 초대했습니다.</p>`,
      `<p>권한: <strong>${params.role}</strong></p>`,
      `<p><a href="${params.inviteUrl}" target="_blank" rel="noopener noreferrer">초대 수락하기</a></p>`,
      `<p style="color:#6b7280;font-size:12px;">${expiresText}</p>`,
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
    console.error("[WorkspaceInviteEmail][SEND_FAIL]", e);
    return { ok: false, error: "send_failed" };
  }
}
