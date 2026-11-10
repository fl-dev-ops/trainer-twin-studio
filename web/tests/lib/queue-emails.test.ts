import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { OutboundEmail } from "@/workflows/send-emails";
import { progressRun } from "@/lib/run-progress";

let startFails = false;
const start = mock(async (..._args: unknown[]) => {
  if (startFails) throw new Error("missing SWC workflow transform");
  return { runId: "wrun_emails" };
});
const person = mock(async (_args: unknown) => ({ success: true }));
const orgCredits = mock(async (_args: unknown) => ({ success: false, error: "Resend unavailable" }));
const realEmail = await import("@/lib/email");
mock.module("workflow/api", () => ({ start }));
mock.module("@/lib/email", () => ({ ...realEmail, sendPersonEmail: person, sendOrgCreditsEmail: orgCredits }));
const { queueEmails, deliverEmail } = await import("@/lib/queue-emails");
const { deliverEmails } = await import("@/workflows/send-emails");
const emails: OutboundEmail[] = [
  { kind: "person", idempotencyKey: "twin:abc", args: { to: "a@example.com", orgName: "Org", twin: { name: "Twin", url: "https://example.com/t/twin" } } },
  { kind: "orgCredits", args: { to: "b@example.com", orgName: "Org", added: 100, balance: 300, creditsUrl: "https://example.com/credits" } },
];
let log: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  startFails = false;
  for (const fn of [start, person, orgCredits]) fn.mockClear();
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); });

test("queueEmails: an empty batch starts nothing and sends nothing", async () => {
  expect(await queueEmails("org-1", [])).toEqual({ emailFailures: 0, emailsQueued: 0 });
  expect(start).not.toHaveBeenCalled();
  expect(person).not.toHaveBeenCalled();
});

test("queueEmails starts send-emails and returns a token bound to the org, sending nothing inline", async () => {
  const result = await queueEmails("org-1", emails);
  expect(start).toHaveBeenCalledWith(deliverEmails, [emails]);
  expect(result).toEqual({ emailFailures: 0, emailsQueued: 2, emailProgress: expect.any(String) });
  expect(progressRun("org-1", result.emailProgress!)).toBe("wrun_emails");
  expect(progressRun("org-2", result.emailProgress!)).toBeNull();
  expect(person).not.toHaveBeenCalled();
  expect(orgCredits).not.toHaveBeenCalled();
});

test("regression: queueEmails fallback preserves each event key while routing kinds and counting failures", async () => {
  startFails = true;
  expect(await queueEmails("org-1", emails)).toEqual({ emailFailures: 1, emailsQueued: 0 });
  expect(person).toHaveBeenCalledWith({ ...emails[0].args, idempotencyKey: emails[0].idempotencyKey });
  expect(orgCredits).toHaveBeenCalledWith({ ...emails[1].args, idempotencyKey: undefined });
  expect(log).toHaveBeenCalledWith("[send-emails] workflow did not start; sending now:", "missing SWC workflow transform");
});

test("deliverEmail sends now with its key; success starts no workflow", async () => {
  const email = { ...emails[0], idempotencyKey: "added:member-1" };
  expect(await deliverEmail(email)).toEqual({ sent: true });
  expect(person).toHaveBeenCalledWith({ ...email.args, idempotencyKey: "added:member-1" });
  expect(start).not.toHaveBeenCalled();
});

test("deliverEmail failure queues the same email with the same key; a queue failure still reports not sent", async () => {
  const email = { ...emails[1], idempotencyKey: "org-credits:grant-1" };
  expect(await deliverEmail(email)).toEqual({ sent: false });
  expect(start).toHaveBeenCalledWith(deliverEmails, [[email]]);
  startFails = true;
  expect(await deliverEmail(email)).toEqual({ sent: false });
  expect(log).toHaveBeenCalledWith("[send-emails] could not queue a retry:", "missing SWC workflow transform");
});
