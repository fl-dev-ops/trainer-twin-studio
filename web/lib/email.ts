import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY;
export const resend = resendApiKey ? new Resend(resendApiKey) : null;

export const DEFAULT_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "TrainerTwin <no-reply@trainertwin.com>";
const DEFAULT_REPLY_TO = "support@trainertwin.com";

export type SendEmailOptions = {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  /** Resend sends one email per key (24 h): a retried workflow step can't send it twice. */
  idempotencyKey?: string;
};

/**
 * Send an email via Resend. Gracefully logs errors in development if API key is not configured.
 */
export async function sendEmail({
  to,
  cc,
  subject,
  html,
  text,
  from = DEFAULT_FROM_EMAIL,
  idempotencyKey,
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
      ...(cc ? { cc } : {}),
      replyTo: DEFAULT_REPLY_TO,
      subject,
      html,
      text,
    }, idempotencyKey ? { idempotencyKey } : undefined);

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
      color: #EC3013;
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
      background-color: #EC3013;
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
  if (!resend && process.env.NODE_ENV === "development") {
    // Local testing still uses a real, expiring OTP; never expose it in an HTTP response.
    console.info(`[Dev sign-in] Code for ${to}: ${otp} (expires in 10 minutes)`);
    return { success: true };
  }

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

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** A section box (objective, what to bring). */
const box = (label: string, body: string) => `<div style="background: #f8fafc; border-left: 4px solid #EC3013; padding: 16px; border-radius: 8px; margin: 20px 0;">
  <p style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin: 0 0 6px;">${escapeHtml(label)}</p>
  <p style="font-size: 14px; margin: 0; color: #1e293b;">${body}</p>
</div>`;

const ROLE_WORDS = { admin: "the admin", team: "a team member", user: "a learner" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What changed for one person, as one email (specs/people.md rule 11): any of being added to an org, a twin, a role
 * play, and credits added. A new learner given a twin gets one email with all three. The button opens what they were
 * given (twin, then role play), else the sign-in link. Every value is escaped.
 */
export type PersonEmailArgs = {
  to: string;
  orgName: string;
  /** Who did it ("Olga Sinenko"); "Your trainer" when unknown. */
  byName?: string;
  /** Added to the org just now. `signInUrl`: the org home (learners) or the studio (admin, team). */
  added?: { role: "admin" | "team" | "user"; signInUrl: string };
  /** `until`: the last day they can use it, already formatted ("30 Nov 2026"); none = no end date. */
  twin?: { name: string; url: string; until?: string | null };
  roleplay?: { name: string; url: string; objective?: string; requiredArtifact?: { label: string; prompt: string } | null };
  /** Learner credits (1 credit = 1 minute of practice): `added` just now (if any) and the balance after. */
  credits?: { added?: number; balance: number };
  idempotencyKey?: string;
};

export function personEmail(args: PersonEmailArgs) {
  const by = args.byName?.trim() || "Your trainer";
  const subject = args.twin
    ? `You can now talk to ${args.twin.name}`
    : args.roleplay
      ? `New role play: ${args.roleplay.name}`
      : args.added
        ? `You've been added to ${args.orgName} on TrainerTwin`
        : `${plural(args.credits?.added ?? 0, "credit")} added to your TrainerTwin account`;
  const button = args.twin
    ? { label: "Start talking", url: args.twin.url }
    : args.roleplay
      ? { label: "Start practice", url: args.roleplay.url }
      : args.added
        ? { label: "Sign in", url: args.added.signInUrl }
        : null;

  const lines: string[] = [];
  const text: string[] = [];
  if (args.added) {
    lines.push(`<strong>${escapeHtml(by)}</strong> added you to <strong>${escapeHtml(args.orgName)}</strong> on TrainerTwin as ${ROLE_WORDS[args.added.role]}.`);
    text.push(`${by} added you to ${args.orgName} on TrainerTwin as ${ROLE_WORDS[args.added.role]}.`);
  }
  if (args.twin) {
    const until = args.twin.until ? ` You can use it until ${escapeHtml(args.twin.until)}.` : "";
    lines.push(`${args.added ? "You" : `<strong>${escapeHtml(by)}</strong> gave you`} ${args.added ? "can now talk to" : "access to"} <strong>${escapeHtml(args.twin.name)}</strong>: ask about the real situations you're working on, by voice.${until}`);
    text.push(`You can now talk to ${args.twin.name}.${args.twin.until ? ` Until ${args.twin.until}.` : ""}`);
  }
  if (args.roleplay) {
    lines.push(`${args.added || args.twin ? "You have" : `<strong>${escapeHtml(by)}</strong> gave you`} ${args.added || args.twin ? "a new role play:" : "the role play"} <strong>${escapeHtml(args.roleplay.name)}</strong>. You can practise it as many times as you like while your credits last.`);
    text.push(`New role play: ${args.roleplay.name}.`);
  }
  if (args.credits) {
    const added = args.credits.added ? `${args.added || args.twin || args.roleplay ? "You have" : `<strong>${escapeHtml(by)}</strong> added`} <strong>${plural(args.credits.added, "credit")}</strong>${args.added || args.twin || args.roleplay ? "" : " to your account"}. ` : "";
    lines.push(`${added}Your balance is <strong>${plural(args.credits.balance, "credit")}</strong> (1 credit = 1 minute of practice, for any twin or role play).`);
    text.push(`${args.credits.added ? `${plural(args.credits.added, "credit")} added. ` : ""}Your balance: ${plural(args.credits.balance, "credit")} (1 credit = 1 minute of practice).`);
  }
  const extras = [
    args.roleplay?.objective ? box("Objective", `&ldquo;${escapeHtml(args.roleplay.objective)}&rdquo;`) : "",
    args.roleplay?.requiredArtifact?.prompt ? box("What to bring", escapeHtml(args.roleplay.requiredArtifact.prompt)) : "",
  ].join("");
  const signIn = `Sign in with Google or an email code, using <strong>${escapeHtml(args.to)}</strong>.`;

  const html = renderEmailLayout({
    title: escapeHtml(subject),
    previewText: escapeHtml(text[0] ?? subject),
    contentHtml: `
      <h1>${escapeHtml(subject)}</h1>
      <p>Hi there,<br>${lines.join("<br><br>")}</p>
      ${extras}
      ${button ? `<p>${signIn}</p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="${escapeHtml(button.url)}" class="btn" target="_blank">${button.label}</a>
      </div>
      <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
        Or open this link:<br>
        <a href="${escapeHtml(button.url)}" class="muted-link">${escapeHtml(button.url)}</a>
      </p>` : ""}
    `,
  });
  return {
    subject,
    html,
    text: `${text.join(" ")}${args.roleplay?.objective ? ` Objective: ${args.roleplay.objective}.` : ""}${args.roleplay?.requiredArtifact?.prompt ? ` What to bring: ${args.roleplay.requiredArtifact.prompt}.` : ""}${button ? ` Sign in with Google or an email code, using ${args.to}: ${button.url}` : ""}`,
  };
}

export function sendPersonEmail(args: PersonEmailArgs) {
  return sendEmail({ to: args.to, ...personEmail(args), idempotencyKey: args.idempotencyKey });
}

/** Org credits arrived (Meteroid grant or top-up), to the org's admin: how many, the new balance, and when they expire. */
export type OrgCreditsEmailArgs = {
  to: string;
  orgName: string;
  added: number;
  balance: number;
  /** Formatted ("10 Nov 2027"); none = no expiry. */
  expires?: string | null;
  reason?: string | null;
  creditsUrl: string;
  idempotencyKey?: string;
};

export function orgCreditsEmail(args: OrgCreditsEmailArgs) {
  const subject = `${plural(args.added, "credit")} added to ${args.orgName}`;
  const expiry = args.expires ? ` They expire on ${escapeHtml(args.expires)}.` : "";
  const html = renderEmailLayout({
    title: escapeHtml(subject),
    previewText: escapeHtml(`${subject}. New balance: ${plural(args.balance, "credit")}.`),
    contentHtml: `
      <h1>${escapeHtml(subject)}</h1>
      <p>Hi there,<br><strong>${plural(args.added, "credit")}</strong>${args.reason ? ` (${escapeHtml(args.reason)})` : ""} were added to <strong>${escapeHtml(args.orgName)}</strong>.${expiry}
      Your organization's balance is now <strong>${plural(args.balance, "credit")}</strong> (1 credit = 1 minute of practice).</p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="${escapeHtml(args.creditsUrl)}" class="btn" target="_blank">See credits</a>
      </div>
    `,
  });
  return {
    subject,
    html,
    text: `${subject}${args.reason ? ` (${args.reason})` : ""}.${args.expires ? ` They expire on ${args.expires}.` : ""} New balance: ${plural(args.balance, "credit")}. ${args.creditsUrl}`,
  };
}

export function sendOrgCreditsEmail(args: OrgCreditsEmailArgs) {
  return sendEmail({ to: args.to, ...orgCreditsEmail(args), idempotencyKey: args.idempotencyKey });
}

/** A user's "Report an issue", for the team (lib/issue-alerts.ts): who, where, what they wrote, and where to look. */
export async function sendIssueReportEmail(input: {
  to: string;
  cc: string[];
  kind: string;
  reporter: { name: string; email: string };
  org: string | null;
  message: string;
  pageUrl: string | null;
  sessionUrl: string | null;
  posthogEventUrl: string | null;
  replayUrl: string | null;
}) {
  const where = input.org ? ` · ${input.org}` : "";
  const subject = `Issue reported (${input.kind})${where} · ${input.reporter.name || input.reporter.email}`;
  const link = (label: string, url: string | null) =>
    url ? `<li><strong>${label}:</strong> <a href="${escapeHtml(url)}" class="muted-link">${escapeHtml(url)}</a></li>` : "";
  const html = renderEmailLayout({
    title: escapeHtml(subject),
    previewText: escapeHtml(input.message.slice(0, 120)),
    contentHtml: `
      <h1>Issue reported</h1>
      <p>
        <strong>${escapeHtml(input.reporter.name || input.reporter.email)}</strong> (${escapeHtml(input.reporter.email)})${input.org ? ` in <strong>${escapeHtml(input.org)}</strong>` : ""}
        reported a <strong>${escapeHtml(input.kind)}</strong>.
      </p>
      <p style="white-space: pre-wrap; padding: 12px 16px; background: #f1f5f9; border-radius: 8px;">${escapeHtml(input.message)}</p>
      <ul>
        ${link("PostHog", input.posthogEventUrl)}
        ${link("Session replay", input.replayUrl)}
        ${link("Session", input.sessionUrl)}
        ${link("Page", input.pageUrl)}
      </ul>
    `,
  });
  const text = [
    `${input.reporter.name || input.reporter.email} (${input.reporter.email})${input.org ? ` in ${input.org}` : ""} reported a ${input.kind}.`,
    "",
    input.message,
    "",
    ...[["PostHog", input.posthogEventUrl], ["Session replay", input.replayUrl], ["Session", input.sessionUrl], ["Page", input.pageUrl]]
      .filter(([, url]) => url)
      .map(([label, url]) => `${label}: ${url}`),
  ].join("\n");
  return sendEmail({ to: input.to, cc: input.cc, subject, html, text });
}
