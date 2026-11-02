import "server-only";
import { createTransport, type SendMailOptions } from "nodemailer";
import { getServerConfig } from "@/lib/config/server";
import wordmark from "./wordmark.json";

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  attachments?: SendMailOptions["attachments"];
}

export type EmailDeliveryResult =
  | { success: true; id?: string }
  | { success: false; reason: "provider_error" | "EMAIL_DISABLED" };

// Bounds the invite Server Action, so the one-time Copy Link still returns when SMTP stalls.
const SMTP_CONNECTION_TIMEOUT_MS = 5_000;
const SMTP_GREETING_TIMEOUT_MS = 5_000;
const SMTP_SOCKET_TIMEOUT_MS = 5_000;
const SMTP_SEND_DEADLINE_MS = 8_000;

export async function sendEmail(
  params: SendEmailParams,
): Promise<EmailDeliveryResult> {
  const config = getServerConfig();
  const from = params.from || config.email.from;

  if (config.email.isDevLogger) {
    console.log("----------------------------------------");
    console.log("[DEV EMAIL LOGGER] (No SMTP_HOST configured)");
    console.log(
      `To: ${Array.isArray(params.to) ? params.to.join(", ") : params.to}`,
    );
    console.log(`From: ${from}`);
    console.log(`Subject: ${params.subject}`);
    console.log("----------------------------------------");
    return { success: true, id: "dev-mock-id" };
  }

  // Production without SMTP settings: the pilot shares invite links by Copy
  // Link. Log nothing here, because the message may carry an invite URL or code.
  const smtp = config.email.smtp;
  if (!smtp) {
    return { success: false, reason: "EMAIL_DISABLED" };
  }

  // Port 465 is implicit TLS. Every other port must upgrade with STARTTLS
  // before AUTH, so SMTP credentials never cross an unencrypted connection.
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    auth: { user: smtp.user, pass: smtp.password },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(new Error("SMTP send deadline exceeded"), {
          code: "ETIMEDOUT",
        }),
      );
    }, SMTP_SEND_DEADLINE_MS);
  });

  try {
    const sending = transport.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      attachments: params.attachments,
    });
    // If the deadline wins, this send rejects later with no other handler.
    sending.catch(() => undefined);
    const info = await Promise.race([sending, deadline]);

    return { success: true, id: info.messageId };
  } catch (error) {
    // Only the SMTP error code: the message can carry the recipient or invite.
    console.error(
      `[Email Error]: SMTP delivery failed (${smtpErrorCode(error)})`,
    );
    return { success: false, reason: "provider_error" };
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}

function smtpErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function sendStaffInviteEmail(params: {
  to: string;
  shopName: string;
  inviteCode: string;
  inviteUrl: string;
}) {
  const safeShopName = escapeHtml(params.shopName);
  const safeRecipient = escapeHtml(params.to);
  const safeCode = escapeHtml(params.inviteCode);
  const safeUrl = escapeHtml(params.inviteUrl);
  const subject = `You're invited to join ${params.shopName} on Tracknologia`;
  // Inline brand colors and presentation tables keep the layout usable without app CSS.
  const html = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Your Tracknologia invitation</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #faf8f3;">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">Join ${safeShopName} on Tracknologia. Your staff invitation is inside.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; background-color: #faf8f3;">
      <tr>
        <td align="center" style="padding: 20px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 520px; table-layout: fixed; border: 1px solid #e9e4d8; border-spacing: 0; border-radius: 6px; background-color: #ffffff;">
            <tr>
              <td bgcolor="#141414" style="padding: 16px 20px; border-radius: 5px 5px 0 0; font-family: Arial, Helvetica, sans-serif;">
                <img src="cid:tracknologia-wordmark" width="143" height="26" alt="Tracknologia" style="display: block; width: 143px; height: 26px; border: 0; color: #ffffff; font-size: 18px; font-weight: bold;">
              </td>
            </tr>
            <tr>
              <td style="padding: 22px 20px; font-family: Arial, Helvetica, sans-serif; color: #141414;">
                <h1 style="margin: 0 0 12px; font-family: Arial, Helvetica, sans-serif; font-size: 22px; line-height: 28px; font-weight: 700; letter-spacing: -0.3px;">You're invited to the team.</h1>
                <p style="margin: 0 0 12px; font-size: 14px; line-height: 22px; color: #45403a; word-wrap: break-word;">Join <strong style="color: #141414;">${safeShopName}</strong> as staff on Tracknologia.</p>
                <p style="margin: 0 0 18px; font-size: 13px; line-height: 20px; color: #6b6455; word-break: break-word;">Use <strong style="color: #141414;">${safeRecipient}</strong> to join. This invitation is linked to that email address.</p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%;">
                  <tr>
                    <td align="center" bgcolor="#ffc72c" style="border-radius: 4px; font-family: Arial, Helvetica, sans-serif;">
                      <a href="${safeUrl}" style="display: block; padding: 11px 16px; border: 1px solid #ffc72c; border-radius: 4px; font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 22px; font-weight: bold; color: #141414; text-align: center; text-decoration: none;">Accept invitation</a>
                    </td>
                  </tr>
                </table>

                <h2 style="margin: 20px 0 6px; font-size: 14px; line-height: 22px; font-weight: bold;">Joining with a code?</h2>
                <p style="margin: 0 0 10px; font-size: 13px; line-height: 20px; color: #6b6455;">You can also enter this code during Staff setup.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; table-layout: fixed;">
                  <tr>
                    <td bgcolor="#f3f0e8" style="padding: 12px; border: 1px solid #e9e4d8; border-radius: 4px; font-family: Arial, Helvetica, sans-serif;">
                      <p style="margin: 0 0 6px; font-size: 12px; line-height: 18px; color: #6b6455;">Invitation code</p>
                      <p style="margin: 0; font-family: Consolas, 'Courier New', monospace; font-size: 14px; line-height: 22px; font-weight: bold; color: #141414; word-break: break-all; word-wrap: break-word;">${safeCode}</p>
                    </td>
                  </tr>
                </table>

                <div style="margin-top: 18px; padding-top: 14px; border-top: 1px solid #e9e4d8;">
                  <p style="margin: 0 0 6px; font-size: 13px; line-height: 20px; color: #6b6455;">If the button doesn't open, copy this link into your browser:</p>
                  <p style="margin: 0; font-size: 13px; line-height: 20px; word-break: break-all; word-wrap: break-word;"><a href="${safeUrl}" style="color: #141414; text-decoration: underline;">${safeUrl}</a></p>
                </div>
              </td>
            </tr>
            <tr>
              <td bgcolor="#f3f0e8" style="padding: 14px 20px; border-top: 1px solid #e9e4d8; border-radius: 0 0 5px 5px; font-family: Arial, Helvetica, sans-serif;">
                <p style="margin: 0 0 6px; font-size: 13px; line-height: 20px; font-weight: bold; color: #141414;">Valid for 7 days from creation.</p>
                <p style="margin: 0; font-size: 12px; line-height: 19px; color: #6b6455;">Keep this invitation private. If you weren't expecting it, you can safely ignore this email.</p>
              </td>
            </tr>
          </table>
          <p style="margin: 18px 0 0; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 18px; color: #6b6455;">Tracknologia &middot; Repair operations &amp; tracking</p>
        </td>
      </tr>
    </table>
  </body>
</html>
  `;

  const text = `
You're invited to join ${params.shopName} as staff on Tracknologia.

Use ${params.to} to join. This invitation is linked to that email address.

Accept invitation: ${params.inviteUrl}

You can also enter this code during Staff setup:
${params.inviteCode}

Valid for 7 days from creation.
Keep this invitation private. If you weren't expecting it, you can safely ignore this email.
  `.trim();

  return sendEmail({
    to: params.to,
    subject,
    html,
    text,
    attachments: [
      {
        filename: "tracknologia.png",
        content: wordmark,
        encoding: "base64",
        contentType: "image/png",
        cid: "tracknologia-wordmark",
      },
    ],
  });
}
