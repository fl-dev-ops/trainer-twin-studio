import { expect, test } from "bun:test";
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
import type { IssueReportEmailArgs } from "@/emails/report-shared";
import { billingEmail } from "@/lib/email";

const billing: BillingEmailArgs = {
  event: "issued", orgName: "Org <one>", invoiceNumber: "INV-<1>", amount: "$25.00", dueDate: "13 Nov 2026",
  description: "Minute <pack>", billingUrl: "https://dash.example.com/billing?a=1&b=2", payUrl: "https://pay.example.com?a=1&b=2",
  outcome: "Credits <added>",
};

for (const [event, render] of [
  ["issued", invoiceIssuedEmail], ["reminder", invoiceReminderEmail], ["paused", planPausedEmail],
  ["upgrade_cancelled", upgradeCancelledEmail], ["paid", invoicePaidEmail],
] as const) {
  test(`${event} has its own template and keeps the billing entry point's output`, () => {
    const args = { ...billing, event };
    const result = render(args);
    expect(billingEmail(args)).toEqual(result);
    expect(result.html).toStartWith("<!DOCTYPE html>");
    expect(result.html).toContain("INV-&lt;1&gt;");
    expect(result.html).not.toContain("INV-<1>");
    expect(result.html).toContain('href="https://dash.example.com/billing?a=1&amp;b=2"');
    expect(result.text).toContain("INV-<1>");
    if (event === "issued" || event === "reminder" || event === "paused") {
      expect(result.html).toContain("Pay $25.00 now");
      expect(result.text).toContain(`Pay online: ${billing.payUrl}`);
      const withoutLink = render({ ...args, payUrl: null });
      expect(withoutLink.text).toContain("reply to this email and we'll send you a payment link.");
    } else {
      expect(result.html).not.toContain("Pay $25.00 now");
      expect(result.text).not.toContain("Pay online:");
    }
  });
}

test("sign-in, combined person and org-credit templates render without sending", () => {
  const otp = otpEmail({ to: "learner@example.com", otp: "123456" });
  expect(otp.subject).toBe("Your TrainerTwin Sign In code: 123456");
  expect(otp.html).toContain("This code expires in 10 minutes.");
  expect(otp.text).toContain("Your sign-in code: 123456");
  expect(otp.text).toContain("expires in 10 minutes");

  const person = personEmail({
    to: "learner@example.com", orgName: "Org <one>", added: { role: "user", signInUrl: "https://org.example.com/" },
    twin: { name: "Twin <one>", url: "https://org.example.com/t/one" }, credits: { added: 30, balance: 30 },
  });
  expect(person.subject).toBe("You can now talk to Twin <one>");
  expect(person.html).toContain("Org &lt;one&gt;");
  expect(person.html).toContain("Twin &lt;one&gt;");
  expect(person.html).toContain("30 credits");
  expect(person.html.match(/class="btn"/g)).toHaveLength(1);

  const credits = orgCreditsEmail({ to: "admin@example.com", orgName: "Org", added: 100, balance: 130, reason: "Grant <one>", expires: "13 Nov 2027", creditsUrl: "https://dash.example.com/usage" });
  expect(credits.subject).toBe("100 credits added to Org");
  expect(credits.html).toContain("Grant &lt;one&gt;");
  expect(credits.text).toContain("Expires: 13 Nov 2027");
  expect(credits.text).toContain("New balance: 130 credits");
});

const report: IssueReportEmailArgs = {
  to: "devops@example.com", cc: [], kind: "bug", reporter: { name: "Reporter <one>", email: "reporter@example.com" },
  org: "Org", message: "Help <please>\nMore details", pageUrl: "https://dash.example.com/billing?a=1&b=2",
  sessionUrl: null, replayUrl: null, posthogEventUrl: null,
};

test("issue and support have separate templates with escaped reporter/message and the same context links", () => {
  const issue = issueReportEmail(report);
  const support = supportRequestEmail({ ...report, kind: "support" });
  expect(issue.subject).toBe("Issue reported (bug) · Org · Reporter <one>");
  expect(issue.html).toContain(">Issue reported</h1>");
  expect(support.subject).toBe("Support: Help <please> · Org · Reporter <one>");
  expect(support.html).toContain(">Support request</h1>");
  expect(support.html).toContain("Reply to this email to answer the reporter.");
  for (const result of [issue, support]) {
    expect(result.html).toContain("Reporter &lt;one&gt;");
    expect(result.html).toContain("Help &lt;please&gt;");
    expect(result.html).toContain('href="https://dash.example.com/billing?a=1&amp;b=2"');
    expect(result.text).toContain("Help <please>");
    expect(result.text).toContain("More details");
    expect(result.text).toContain(report.pageUrl!);
  }
});
