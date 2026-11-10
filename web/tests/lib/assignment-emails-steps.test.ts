import { beforeEach, expect, mock, test } from "bun:test";
import type { AssignmentEmail, EmailProgress } from "@/workflows/assignment-emails";

const workflow = await import("workflow");
const { FatalError } = workflow;
let stepId = "step-invite-1";
let result: { success: boolean; error?: string } = { success: true };
const twin = mock(async (_args: unknown) => result);
const roleplay = mock(async (_args: unknown) => result);
const events: EmailProgress[] = [];
const write = mock(async (event: EmailProgress) => { events.push(event); });
const releaseLock = mock(() => {});
const close = mock(async () => {});
mock.module("workflow", () => ({
  ...workflow,
  getStepMetadata: () => ({ stepId }),
  getWritable: () => ({ getWriter: () => ({ write, releaseLock }), close }),
}));
mock.module("@/lib/email", () => ({ sendTwinAssignmentEmail: twin, sendRolePlayAssignmentEmail: roleplay }));
const { sendOne, markFailed, finish } = await import("@/workflows/assignment-emails-steps");
const emails: AssignmentEmail[] = [
  { kind: "twin", args: { to: "a@example.com", twinName: "Twin", minutes: 30, practiceUrl: "https://example.com/t/twin" } },
  { kind: "roleplay", args: { to: "b@example.com", rolePlayName: "Practice", practiceUrl: "https://example.com/s/code" } },
];
beforeEach(() => {
  result = { success: true }; stepId = "step-invite-1"; events.length = 0;
  for (const fn of [twin, roleplay, write, releaseLock, close]) fn.mockClear();
});

test.each(emails)("sendOne routes $kind with stepId as the idempotency key, then writes sent", async (email) => {
  await sendOne(email);
  const sender = email.kind === "twin" ? twin : roleplay;
  const other = email.kind === "twin" ? roleplay : twin;
  expect(sender).toHaveBeenCalledWith({ ...email.args, idempotencyKey: stepId });
  expect(other).not.toHaveBeenCalled();
  expect(events).toEqual([{ to: email.args.to, status: "sent" }]);
  expect(sender.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  expect(releaseLock).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  expect(sendOne.maxRetries).toBe(4);
  // A retry of the same step reuses the key; another step gets its own key.
  await sendOne(email);
  expect(sender.mock.calls[1][0]).toEqual({ ...email.args, idempotencyKey: stepId });
  stepId = "step-invite-2";
  await sendOne(email);
  expect(sender.mock.calls[2][0]).toEqual({ ...email.args, idempotencyKey: stepId });
});

test.each(emails)("sendOne $kind missing Resend key is fatal and writes no sent event", async (email) => {
  result = { success: false, error: "RESEND_API_KEY is not set" };
  const error = await sendOne(email).catch((error: unknown) => error);
  expect(FatalError.is(error)).toBe(true);
  expect(error).toMatchObject({ message: `Invite to ${email.args.to}: RESEND_API_KEY is not set` });
  expect(events).toEqual([]);
});

test("sendOne other Resend failures throw a plain retryable Error without reporting sent", async () => {
  result = { success: false, error: "Resend unavailable" };
  const error = await sendOne(emails[0]).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).constructor).toBe(Error);
  expect(FatalError.is(error)).toBe(false);
  expect(error).toMatchObject({ message: "Invite to a@example.com: Resend unavailable" });
  expect(events).toEqual([]);
});

test("markFailed writes a failed event; finish writes done, releases the writer, then closes", async () => {
  await markFailed("a@example.com");
  expect(close).not.toHaveBeenCalled();
  await finish({ sent: 1, failed: ["a@example.com"] });
  expect(events).toEqual([
    { to: "a@example.com", status: "failed" },
    { status: "done", sent: 1, failed: ["a@example.com"] },
  ]);
  expect(releaseLock).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(1);
  expect(write.mock.invocationCallOrder[1]).toBeLessThan(releaseLock.mock.invocationCallOrder[1]);
  expect(releaseLock.mock.invocationCallOrder[1]).toBeLessThan(close.mock.invocationCallOrder[0]);
});
