import { expect, test } from "bun:test";
import { renderEmailLayout } from "@/emails/layout";
import { emailDetails, emailButton } from "@/emails/components";
import { otpEmail } from "@/emails/otp";
import { personEmail } from "@/emails/person";
import { orgCreditsEmail } from "@/emails/org-credits";
import { invoiceIssuedEmail } from "@/emails/invoice-issued";
import { invoiceReminderEmail } from "@/emails/invoice-reminder";
import { planPausedEmail } from "@/emails/plan-paused";
import { upgradeCancelledEmail } from "@/emails/upgrade-cancelled";
import { invoicePaidEmail } from "@/emails/invoice-paid";
import { issueReportEmail } from "@/emails/issue-report";
import { supportRequestEmail } from "@/emails/support-request";
import type { BillingEmailArgs } from "@/emails/billing-shared";

const billing: BillingEmailArgs = { event: "issued", orgName: "Acme", invoiceNumber: "INV-1", amount: "$300.00", description: "Paid plan", dueDate: "13 Nov 2026", billingUrl: "https://example.com/billing", payUrl: "https://example.com/pay" };
const report = { to: "team@example.com", cc: [], kind: "bug", reporter: { name: "Lee", email: "lee@example.com" }, org: "Acme", message: "Help with a call\n\nIt stopped responding.", pageUrl: "https://example.com/call", sessionUrl: "https://example.com/session", replayUrl: null, posthogEventUrl: null };
const samples = [
  otpEmail({ to: "lee@example.com", otp: "123456" }),
  personEmail({ to: "lee@example.com", orgName: "Acme", twin: { name: "Olga", url: "https://example.com/twin" }, credits: { added: 30, balance: 50 } }),
  orgCreditsEmail({ to: "admin@example.com", orgName: "Acme", added: 100, balance: 200, creditsUrl: "https://example.com/usage" }),
  invoiceIssuedEmail(billing), invoiceReminderEmail({ ...billing, event: "reminder" }), planPausedEmail({ ...billing, event: "paused" }),
  upgradeCancelledEmail({ ...billing, event: "upgrade_cancelled" }), invoicePaidEmail({ ...billing, event: "paid" }),
  issueReportEmail(report), supportRequestEmail({ ...report, kind: "support" }),
];

for (const [index, sample] of samples.entries()) {
  test(`template ${index + 1} uses the shared design with only the sidebar logo as an image`, () => {
    expect(sample.html).not.toMatch(/<svg\b|<script\b|@font-face|display:\s*(flex|grid)|<style\b/i);
    expect(sample.html.match(/<img\b/g)).toHaveLength(1);
    expect(sample.html).toContain('src="https://dash.trainertwin.com/trainertwin-email-mark.png"');
    expect(sample.html).toContain('width="24" height="24"');
    expect(sample.html).toContain(">TrainerTwin</td>");
    expect(sample.html).toContain("font-family:Arial,Helvetica,sans-serif");
    expect(sample.html).toContain("max-width:560px");
    expect(sample.html).toContain("<!--[if mso]>");
    expect(sample.html.match(/<h1\b/g)).toHaveLength(1);
    const heading = sample.html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1];
    expect(heading!.length).toBeLessThan(40);
    expect(sample.html.match(/class="btn"/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(sample.text.length).toBeGreaterThan(0);
    expect(sample.html).not.toMatch(/Hi there|All rights reserved|Or open this link/);
  });
}

test("email buttons match the product's brand variant: orange pill, white label", () => {
  const html = emailButton("View billing", "https://example.com/billing");
  expect(html).toContain("background-color:#ff5a00");
  expect(html).toContain("bgcolor=\"#ff5a00\"");
  expect(html).toContain("border-radius:999px");
  expect(html).toContain("color:#ffffff");
  // 14px semibold stays large-text-eligible only at the heavier button weight; the app ships the same pair.
  expect(html).toContain("font-weight:600");
});

test("shared layout and details escape dynamic text and links", () => {
  const html = renderEmailLayout({ title: '<img src="x">', previewText: '"secret" <value>', contentHtml: emailDetails([["<label>", "<script>alert(1)</script>"]]) + emailButton('Pay "now"', 'https://example.com?a=1&b="x"') });
  expect(html).not.toContain('<img src="x">');
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;label&gt;");
  expect(html).toContain('href="https://example.com?a=1&amp;b=&quot;x&quot;"');
});

test("billing headings stay short while invoice identifiers and consequences remain in the details", () => {
  expect(invoiceIssuedEmail(billing).html).toContain(">Your invoice is ready</h1>");
  const paused = planPausedEmail({ ...billing, event: "paused" });
  expect(paused.text).toContain("New calls and learner credit assignments are paused");
  expect(paused.text).toContain("Pay your overdue invoices to resume");
  expect(paused.text).toContain("Your credits and history are kept");
  const outcome = "Your plan stays paused until the other overdue invoice is paid.";
  expect(invoicePaidEmail({ ...billing, event: "paid", outcome }).text).toContain(outcome);
  expect(upgradeCancelledEmail({ ...billing, event: "upgrade_cancelled" }).text).toContain("You're still on the Trial plan");
});

test("a combined person email retains all access details and both practice links", () => {
  const result = personEmail({ to: "lee@example.com", orgName: "Acme", added: { role: "user", signInUrl: "https://example.com/" }, twin: { name: "Olga", url: "https://example.com/twin", until: "30 Nov 2026" }, roleplay: { name: "Cold call", url: "https://example.com/roleplay", objective: "Book a meeting", requiredArtifact: { label: "Notes", prompt: "Bring notes" } }, credits: { added: 30, balance: 50 } });
  for (const value of ["Access until: 30 Nov 2026", "Credits added: 30 credits", "Your balance: 50 credits", "Objective: Book a meeting", "What to bring: Bring notes", "https://example.com/twin", "https://example.com/roleplay"]) expect(result.text).toContain(value);
});

test("support keeps the complete user message, even when it is much longer than the template copy", () => {
  const message = "Question about billing\n\n" + "More details. ".repeat(300);
  const result = supportRequestEmail({ ...report, kind: "support", message });
  expect(result.text).toContain("Subject: Question about billing");
  expect(result.text).toContain("More details. ".repeat(300));
  expect(result.html).toContain("More details. ".repeat(300));
});
