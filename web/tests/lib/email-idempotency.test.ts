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
