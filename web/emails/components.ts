/** Shared, image-free email building blocks. Inline styles and tables keep the same treatment in Gmail and Outlook. */
import { escapeHtml } from "./helpers";

export type EmailDetail = readonly [label: string, value: string];
const FONT = "Arial, Helvetica, sans-serif";

export const emailParagraph = (text: string) => `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:#3f3f46;overflow-wrap:anywhere;">${escapeHtml(text)}</p>`;
export const emailNote = (text: string) => `<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:#62626b;overflow-wrap:anywhere;">${escapeHtml(text)}</p>`;

/** Label/value rows keep amounts, dates, access and balances out of long paragraphs. All values are plain text. */
export function emailDetails(rows: readonly EmailDetail[]) {
  if (!rows.length) return "";
  return `<table width="100%" cellpadding="0" cellspacing="0" aria-label="Details" style="width:100%;table-layout:fixed;border-collapse:collapse;margin:20px 0;">
    <tbody>${rows.map(([label, value]) => `<tr>
      <th scope="row" width="35%" align="left" valign="top" style="width:35%;padding:10px 12px 10px 0;border-bottom:1px solid #e8e8eb;font-family:${FONT};font-size:14px;line-height:22px;font-weight:400;color:#62626b;overflow-wrap:anywhere;">${escapeHtml(label)}</th>
      <td align="left" valign="top" style="padding:10px 0;border-bottom:1px solid #e8e8eb;font-family:${FONT};font-size:14px;line-height:22px;color:#18181b;overflow-wrap:anywhere;word-wrap:break-word;">${escapeHtml(value)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

/** The product's primary button: orange pill with a white label (the app's brand variant). */
export const emailButton = (label: string, url: string) => `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:24px 0 0;">
  <tr><td align="center" bgcolor="#ff5a00" style="background-color:#ff5a00;border-radius:999px;mso-padding-alt:12px 22px;">
    <a href="${escapeHtml(url)}" class="btn" target="_blank" style="display:inline-block;padding:12px 22px;border:1px solid #ff5a00;border-radius:999px;font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;

/** Secondary links have names instead of printing long URLs in the HTML email; plain text keeps the URLs. */
export const emailLink = (label: string, url: string) => `<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:20px;">
  <a href="${escapeHtml(url)}" target="_blank" style="color:#52525b;text-decoration:underline;overflow-wrap:anywhere;">${escapeHtml(label)}</a>
</p>`;

/** The single code treatment, used for sign-in rather than an image or six separate inputs. */
export const emailCode = (code: string) => `<p class="code-box" style="margin:24px 0;padding:20px;border:1px solid #e8e8eb;border-radius:8px;background-color:#f7f7f8;font-family:Arial,Helvetica,sans-serif;font-size:32px;line-height:40px;letter-spacing:6px;font-weight:600;text-align:center;color:#18181b;">${escapeHtml(code)}</p>`;

/** A complete user-written report, escaped while preserving line breaks. */
export const emailMessage = (message: string) => `<p style="margin:20px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#3f3f46;white-space:pre-wrap;overflow-wrap:anywhere;">${escapeHtml(message)}</p>`;

/** Plain-text emails carry the same details in the same order. */
export const detailsText = (rows: readonly EmailDetail[]) => rows.map(([label, value]) => `${label}: ${value}`).join("\n");
