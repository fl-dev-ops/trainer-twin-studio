import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY;
export const resend = resendApiKey ? new Resend(resendApiKey) : null;

export const DEFAULT_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "TrainerTwin <no-reply@trainertwin.com>";

export type SendEmailOptions = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
};

/**
 * Send an email via Resend. Gracefully logs errors in development if API key is not configured.
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  from = DEFAULT_FROM_EMAIL,
}: SendEmailOptions) {
  if (!resend) {
    console.warn(
      `[Email] RESEND_API_KEY is not set. Skipped sending "${subject}" to ${Array.isArray(to) ? to.join(", ") : to}`,
    );
    return { success: false, error: "RESEND_API_KEY is not set" };
  }

  try {
    const result = await resend.emails.send({
      from,
      to,
      subject,
      html,
      text,
    });

    if (result.error) {
      console.error("[Email Error]:", result.error);
      return { success: false, error: result.error.message };
    }

    return { success: true, data: result.data };
  } catch (error) {
    console.error("[Email Exception]:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error sending email",
    };
  }
}

/**
 * Branded email template wrapper for TrainerTwin
 */
function renderEmailLayout({
  title,
  previewText,
  contentHtml,
}: {
  title: string;
  previewText?: string;
  contentHtml: string;
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${previewText ? `<meta name="description" content="${previewText}">` : ""}
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 0;
      background-color: #f8fafc;
      color: #0f172a;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      max-width: 540px;
      margin: 40px auto;
      background: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid #e2e8f0;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
    }
    .header {
      padding: 32px 36px 24px;
      border-bottom: 1px solid #f1f5f9;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-badge {
      display: inline-block;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #4648D4;
      text-decoration: none;
    }
    .content {
      padding: 36px;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      line-height: 1.3;
      margin: 0 0 16px;
      color: #0f172a;
      letter-spacing: -0.3px;
    }
    p {
      font-size: 15px;
      line-height: 1.6;
      color: #475569;
      margin: 0 0 20px;
    }
    .btn {
      display: inline-block;
      background-color: #4648D4;
      color: #ffffff !important;
      font-size: 15px;
      font-weight: 600;
      padding: 12px 24px;
      border-radius: 10px;
      text-decoration: none;
      text-align: center;
      margin: 8px 0 24px;
      box-shadow: 0 2px 6px rgba(70, 72, 212, 0.25);
    }
    .code-box {
      background: #f1f5f9;
      border-radius: 10px;
      padding: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 4px;
      color: #0f172a;
      text-align: center;
      margin: 20px 0;
    }
    .footer {
      padding: 24px 36px;
      background-color: #f8fafc;
      border-top: 1px solid #f1f5f9;
      text-align: center;
    }
    .footer p {
      font-size: 12px;
      color: #94a3b8;
      margin: 0;
      line-height: 1.5;
    }
    .muted-link {
      color: #64748b;
      word-break: break-all;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <span class="logo-badge">TrainerTwin</span>
    </div>
    <div class="content">
      ${contentHtml}
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} TrainerTwin. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Send an organization / role play invitation email
 */
export async function sendInvitationEmail({
  to,
  organizationName,
  inviterName,
  inviteUrl,
}: {
  to: string;
  organizationName: string;
  inviterName?: string;
  inviteUrl: string;
}) {
  const subject = `Join ${organizationName} on TrainerTwin`;
  const html = renderEmailLayout({
    title: subject,
    previewText: `${inviterName || "Your team"} invited you to join ${organizationName} on TrainerTwin.`,
    contentHtml: `
      <h1>You're invited to join ${organizationName}</h1>
      <p>
        ${inviterName ? `<strong>${inviterName}</strong> has` : "You have been"} invited to practice with AI interview twins and guided role plays on TrainerTwin.
      </p>
      <p>Click the button below to accept your invitation and create your account:</p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="${inviteUrl}" class="btn" target="_blank">Accept Invitation</a>
      </div>
      <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
        Or copy and paste this link in your browser:<br>
        <a href="${inviteUrl}" class="muted-link">${inviteUrl}</a>
      </p>
    `,
  });

  return sendEmail({
    to,
    subject,
    html,
    text: `You have been invited to join ${organizationName} on TrainerTwin. Accept your invitation here: ${inviteUrl}`,
  });
}

/**
 * Send a Login OTP / Verification Code email
 */
export async function sendOtpEmail({
  to,
  otp,
  purpose = "Sign In",
}: {
  to: string;
  otp: string;
  purpose?: string;
}) {
  const subject = `Your TrainerTwin ${purpose} code: ${otp}`;
  const html = renderEmailLayout({
    title: subject,
    previewText: `Your verification code is ${otp}`,
    contentHtml: `
      <h1>Your verification code</h1>
      <p>Use the 6-digit code below to complete your ${purpose.toLowerCase()} on TrainerTwin:</p>
      <div class="code-box">${otp}</div>
      <p style="font-size: 13px; color: #64748b;">
        This code expires in 10 minutes. If you didn't request this email, you can safely ignore it.
      </p>
    `,
  });

  return sendEmail({
    to,
    subject,
    html,
    text: `Your TrainerTwin verification code is: ${otp}`,
  });
}

/**
 * Send a Password Reset link email
 */
export async function sendPasswordResetEmail({
  to,
  resetUrl,
  userName,
}: {
  to: string;
  resetUrl: string;
  userName?: string;
}) {
  const subject = "Reset your TrainerTwin password";
  const html = renderEmailLayout({
    title: subject,
    previewText: "Reset your password on TrainerTwin",
    contentHtml: `
      <h1>Reset your password</h1>
      <p>
        Hi ${userName || "there"},<br>
        We received a request to reset your TrainerTwin password. Click the button below to choose a new password:
      </p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="${resetUrl}" class="btn" target="_blank">Reset Password</a>
      </div>
      <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
        If you didn't request a password reset, you can safely ignore this email.<br>
        <a href="${resetUrl}" class="muted-link">${resetUrl}</a>
      </p>
    `,
  });

  return sendEmail({
    to,
    subject,
    html,
    text: `Reset your TrainerTwin password here: ${resetUrl}`,
  });
}

/**
 * Send a role play assignment notification email to a learner
 */
export async function sendRolePlayAssignmentEmail({
  to,
  userName,
  rolePlayName,
  rolePlayObjective,
  practiceUrl,
  trainerName = "Vasanth",
}: {
  to: string;
  userName?: string;
  rolePlayName: string;
  rolePlayObjective?: string;
  practiceUrl: string;
  trainerName?: string;
}) {
  const subject = `New Role Play Assigned: ${rolePlayName}`;
  const html = renderEmailLayout({
    title: subject,
    previewText: `You have been assigned to practice "${rolePlayName}" on TrainerTwin.`,
    contentHtml: `
      <h1>New Role Play Assigned</h1>
      <p>
        Hi ${userName || "there"},<br>
        Your trainer <strong>${trainerName}</strong> has assigned you to practice the <strong>${rolePlayName}</strong> interview role play.
      </p>
      ${
        rolePlayObjective
          ? `<div style="background: #f8fafc; border-left: 4px solid #4648D4; padding: 16px; border-radius: 8px; margin: 20px 0;">
              <p style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin: 0 0 6px;">Objective</p>
              <p style="font-size: 14px; font-style: italic; margin: 0; color: #1e293b;">&ldquo;${rolePlayObjective}&rdquo;</p>
            </div>`
          : ""
      }
      <p>When you're ready, click the button below to start your guided practice session:</p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="${practiceUrl}" class="btn" target="_blank">Start Practice Session</a>
      </div>
      <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
        Or access directly via this link:<br>
        <a href="${practiceUrl}" class="muted-link">${practiceUrl}</a>
      </p>
    `,
  });

  return sendEmail({
    to,
    subject,
    html,
    text: `You have been assigned to practice "${rolePlayName}" on TrainerTwin. Start your practice here: ${practiceUrl}`,
  });
}
