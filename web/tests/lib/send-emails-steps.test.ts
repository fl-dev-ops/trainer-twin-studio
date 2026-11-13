import { beforeEach, expect, mock, test } from "bun:test";
import type { EmailProgress, OutboundEmail } from "@/workflows/send-emails";

const workflow = await import("workflow");
const { FatalError } = workflow;
let stepId = "step-1";
let result: { success: boolean; error?: string; status?: number } = { success: true };
const person = mock(async (_args: unknown) => result);
const orgCredits = mock(async (_args: unknown) => result);
const events: EmailProgress[] = [];
const write = mock(async (event: EmailProgress) => { events.push(event); });
const releaseLock = mock(() => {});
const close = mock(async () => {});
const realEmail = await import("@/lib/email");
mock.module("workflow", () => ({
  ...workflow,
  getStepMetadata: () => ({ stepId }),
  getWritable: () => ({ getWriter: () => ({ write, releaseLock }), close }),
}));
mock.module("@/lib/email", () => ({ ...realEmail, sendPersonEmail: person, sendOrgCreditsEmail: orgCredits }));
const { sendOne, markFailed, finish } = await import("@/workflows/steps/send-emails");
const emails: OutboundEmail[] = [
  { kind: "person", args: { to: "a@example.com", orgName: "Org", added: { role: "user", signInUrl: "https://org.example.com/" } } },
  { kind: "orgCredits", args: { to: "b@example.com", orgName: "Org", added: 10, balance: 20, creditsUrl: "https://example.com/credits" } },
];
beforeEach(() => {
  result = { success: true }; stepId = "step-1"; events.length = 0;
  for (const fn of [person, orgCredits, write, releaseLock, close]) fn.mockClear();
});

test.each(emails)("sendOne sends $kind keyed by the step id, then reports it sent", async (email) => {
  const sender = email.kind === "person" ? person : orgCredits;
  const other = email.kind === "person" ? orgCredits : person;
  await sendOne(email);
  expect(sender).toHaveBeenCalledWith({ ...email.args, idempotencyKey: "step-1" });
  expect(other).not.toHaveBeenCalled();
  expect(events).toEqual([{ to: email.args.to, status: "sent" }]);
  expect(sendOne.maxRetries).toBe(4);
  // A retry of the same step reuses its key, so Resend sends it once.
  await sendOne(email);
  expect(sender.mock.calls[1][0]).toEqual({ ...email.args, idempotencyKey: "step-1" });
});

test.each(emails)("sendOne $kind keeps an email's own key across steps", async (email) => {
  await sendOne({ ...email, idempotencyKey: "added:m1" });
  stepId = "step-2";
  await sendOne({ ...email, idempotencyKey: "added:m1" });
  const sender = email.kind === "person" ? person : orgCredits;
  for (const [args] of sender.mock.calls) expect(args).toEqual({ ...email.args, idempotencyKey: "added:m1" });
});

test("sendOne: no Resend key is fatal (no retry); other failures retry; neither reports sent", async () => {
  result = { success: false, error: "RESEND_API_KEY is not set" };
  const fatal = await sendOne(emails[0]).catch((error: unknown) => error);
  expect(FatalError.is(fatal)).toBe(true);
  expect(fatal).toMatchObject({ message: "Email to a@example.com: RESEND_API_KEY is not set" });
  result = { success: false, error: "Resend unavailable" };
  const retry = await sendOne(emails[0]).catch((error: unknown) => error);
  expect(FatalError.is(retry)).toBe(false);
  expect(retry).toMatchObject({ message: "Email to a@example.com: Resend unavailable" });
  expect(events).toEqual([]);
});

test("markFailed reports failed; finish reports done then closes the stream", async () => {
  await markFailed("a@example.com");
  expect(close).not.toHaveBeenCalled();
  await finish({ sent: 1, failed: ["a@example.com"] });
  expect(events).toEqual([{ to: "a@example.com", status: "failed" }, { status: "done", sent: 1, failed: ["a@example.com"] }]);
  expect(close).toHaveBeenCalledTimes(1);
  expect(releaseLock.mock.invocationCallOrder[1]).toBeLessThan(close.mock.invocationCallOrder[0]);
});

test.each([422, 409, 400, 401, 403])("sendOne HTTP %s is FatalError and never reports sent", async (status) => {
  result = { success: false, error: "Permanent rejection", status };
  const error = await sendOne(emails[0]).catch((error: unknown) => error);
  expect(FatalError.is(error)).toBe(true); expect(events).toEqual([]);
});
test.each([500, 429])("sendOne HTTP %s remains retryable and never reports sent", async (status) => {
  result = { success: false, error: "Try again", status };
  const error = await sendOne(emails[0]).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error); expect(FatalError.is(error)).toBe(false); expect(events).toEqual([]);
});
