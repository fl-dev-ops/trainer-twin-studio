/**
 * One visual system for every TrainerTwin email: white canvas, sidebar logo + wordmark, Arial/Helvetica,
 * a short 24px heading, compact detail rows and one orange action. Only the logo is an image;
 * inline styles and layout tables keep the content readable when email clients block external images.
 */
import { escapeHtml } from "./helpers";

// Public app asset, independent of the local/preview host; the adjacent wordmark remains visible when images are blocked.
const LOGO_URL = "https://dash.trainertwin.com/trainertwin-email-mark.png";

export function renderEmailLayout({ title, previewText, contentHtml }: { title: string; previewText?: string; contentHtml: string }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#18181b;-webkit-text-size-adjust:100%;">
  ${previewText ? `<div aria-hidden="true" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(previewText)}</div>` : ""}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background-color:#ffffff;">
    <tr><td align="center" style="padding:32px 20px;">
      <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;table-layout:fixed;border-collapse:collapse;">
        <tr><td style="padding:0 0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td width="24" valign="middle" style="width:24px;padding:0 8px 0 0;"><img src="${LOGO_URL}" width="24" height="24" alt="" role="presentation" style="display:block;width:24px;height:24px;border:0;"></td>
              <td valign="middle" style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:24px;font-weight:700;color:#18181b;">TrainerTwin</td>
            </tr>
          </table>
        </td></tr>
        <tr><td>
          <h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;font-weight:600;color:#18181b;overflow-wrap:anywhere;">${escapeHtml(title)}</h1>
          ${contentHtml}
        </td></tr>
        <tr><td style="padding:32px 0 0;">
          <p style="margin:0;padding:16px 0 0;border-top:1px solid #e8e8eb;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#62626b;">&copy; ${new Date().getFullYear()} TrainerTwin</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}
