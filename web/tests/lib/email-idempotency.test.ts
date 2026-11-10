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

test("sendTwinAssignmentEmail forwards the workflow idempotency key", async () => {
  expect(await email.sendTwinAssignmentEmail({ to: "a@example.com", twinName: "Twin", minutes: 30, practiceUrl: "https://example.com/t/twin", idempotencyKey: "step-twin" })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toBe("step-twin");
});

test("sendRolePlayAssignmentEmail forwards the workflow idempotency key", async () => {
  expect(await email.sendRolePlayAssignmentEmail({ to: "a@example.com", rolePlayName: "Practice", practiceUrl: "https://example.com/s/code", idempotencyKey: "step-roleplay" })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toBe("step-roleplay");
});

test("sendInvitationEmail forwards the public API invitation idempotency key", async () => {
  expect(await email.sendInvitationEmail({ to: "a@example.com", organizationName: "Org", inviteUrl: "https://example.com/join", idempotencyKey: "invitation:1:123" })).toMatchObject({ success: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].key).toBe("invitation:1:123");
  expect(requests[0].body).not.toHaveProperty("idempotencyKey");
});
