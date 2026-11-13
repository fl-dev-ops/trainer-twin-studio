import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const requests: { key: string | null; body: Record<string, unknown> }[] = [];
const server = setupServer(http.post("https://api.resend.com/emails", async ({ request }) => {
  // resend/dist/index.mjs creates this header from options.idempotencyKey.
  requests.push({ key: request.headers.get("Idempotency-Key"), body: await request.json() as Record<string, unknown> });
  return HttpResponse.json({ id: "email_test" });
}));
const originalKey = process.env.RESEND_API_KEY;
let email: typeof import("@/lib/email");
beforeAll(async () => {
  process.env.RESEND_API_KEY = "re_test_idempotency";
  server.listen({ onUnhandledRequest: "error" });
  email = await import("@/lib/email");
});
beforeEach(() => { requests.length = 0; });
afterAll(() => {
  server.close();
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
});

test("sendEmail passes the idempotency key to Resend as an HTTP header, not payload", async () => {
  expect(await email.sendEmail({ to: "a@example.com", subject: "Invite", html: "<p>Hello</p>", idempotencyKey: "step-1" })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toBe("step-1");
  expect(requests[0].body).toMatchObject({ to: "a@example.com", subject: "Invite", html: "<p>Hello</p>" });
  expect(requests[0].body).not.toHaveProperty("idempotencyKey");
});

test("sendEmail without a key keeps legacy sends working without an idempotency header", async () => {
  expect(await email.sendEmail({ to: "a@example.com", subject: "Invite", html: "<p>Hello</p>" })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toBeNull();
  expect(requests[0].body.reply_to).toBe("support@trainertwin.com");
});

test.each([
  { parts: { twin: { name: "Twin", url: "https://example.com/t/twin" } }, key: "twin:code", subject: "You can now talk to Twin" },
  { parts: { roleplay: { name: "Practice", url: "https://example.com/s/code" } }, key: "roleplay:code", subject: "New role play: Practice" },
  { parts: { added: { role: "user" as const, signInUrl: "https://example.com/" } }, key: "added:m1", subject: "You've been added to Org on TrainerTwin" },
  { parts: { credits: { added: 10, balance: 40 } }, key: "credits:org:a@example.com:123", subject: "10 credits added to your TrainerTwin account" },
])("sendPersonEmail forwards $key as a header, never in the payload", async ({ parts, key, subject }) => {
  expect(await email.sendPersonEmail({ to: "a@example.com", orgName: "Org", ...parts, idempotencyKey: key })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toBe(key);
  expect(requests[0].body).toMatchObject({ to: "a@example.com", subject });
  expect(requests[0].body).not.toHaveProperty("idempotencyKey");
});

test("sendOrgCreditsEmail forwards the grant's key", async () => {
  expect(await email.sendOrgCreditsEmail({ to: "admin@example.com", orgName: "Org", added: 10, balance: 20, creditsUrl: "https://example.com/credits", idempotencyKey: "org-credits:g1" })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toBe("org-credits:g1");
});

test("sendOtpEmail sends the 6-digit code with its 10-minute expiry", async () => {
  expect(await email.sendOtpEmail({ to: "a@example.com", otp: "123456" })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toMatchObject({ to: "a@example.com", subject: "Your TrainerTwin Sign In code: 123456" });
  expect(String(requests[0].body.html)).toContain("expires in 10 minutes");
});

test.each(["bug", "support"])("%s report delivery keeps the reporter reply-to and team CC", async (kind) => {
  expect(await email.sendIssueReportEmail({
    to: "devops@example.com", cc: ["team@example.com"], kind, reporter: { name: "Lee", email: "lee@example.com" },
    org: "Acme", message: "Help with billing\nMore details", pageUrl: null, sessionUrl: null, posthogEventUrl: null, replayUrl: null,
  })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toMatchObject({
    to: "devops@example.com", cc: ["team@example.com"], reply_to: "lee@example.com",
    subject: kind === "support" ? "Support: Help with billing · Acme · Lee" : "Issue reported (bug) · Acme · Lee",
  });
});

test("billing delivery keeps its sender, attachments and event idempotency key", async () => {
  expect(await email.sendBillingEmail({
    to: ["accounts@example.com"], args: { event: "paid", orgName: "Acme", invoiceNumber: "INV-1", amount: "$25.00", dueDate: "13 Nov 2026", description: "Minute pack", billingUrl: "https://dash.example.com/billing" },
    attachments: [{ filename: "RCPT-INV-1.pdf", content: Buffer.from("receipt") }], idempotencyKey: "billing-paid-inv1",
  })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toBe("billing-paid-inv1");
  expect(requests[0].body).toMatchObject({
    to: ["accounts@example.com"], from: email.BILLING_FROM_EMAIL, reply_to: "support@trainertwin.com",
    subject: "Payment received for invoice INV-1: thank you",
    attachments: [{ filename: "RCPT-INV-1.pdf", content: Buffer.from("receipt").toString("base64") }],
  });
});

test("email subjects remove CR/LF while preserving the support reply-to", async () => {
  expect(await email.sendEmail({ to: "a@example.com", subject: "  Hello\r\nInjected\nLine\rEnd  ", html: "<p>Safe</p>", replyTo: "reporter@example.com" })).toMatchObject({ success: true });
  expect(requests[0].body).toMatchObject({ subject: "Hello Injected Line End", reply_to: "reporter@example.com" });
});
test("Resend rejection preserves the HTTP status for workflow retry classification", async () => {
  server.use(http.post("https://api.resend.com/emails", () => HttpResponse.json({ name: "validation_error", message: "Invalid recipient", statusCode: 422 }, { status: 422 }), { once: true }));
  expect(await email.sendEmail({ to: "bad", subject: "Invite", html: "<p>Hello</p>" })).toMatchObject({ success: false, error: "Invalid recipient", status: 422 });
});
