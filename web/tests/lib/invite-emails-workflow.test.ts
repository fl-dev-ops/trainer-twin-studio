import { beforeEach, expect, mock, test } from "bun:test";
import type { InviteEmail } from "@/workflows/invite-emails";

const calls: unknown[][] = [];
const failures = new Set<string>();
mock.module("@/workflows/steps/invite-emails", () => ({
  sendOne: async (email: InviteEmail) => {
    calls.push(["send", email]);
    if (failures.has(email.args.to)) throw new Error("retries exhausted");
  },
  markFailed: async (to: string) => { calls.push(["failed", to]); },
  finish: async (summary: unknown) => { calls.push(["done", summary]); },
}));
const { sendInviteEmails } = await import("@/workflows/invite-emails");
const emails: InviteEmail[] = [
  { kind: "twin", args: { to: "a@example.com", twinName: "Twin", minutes: 30, practiceUrl: "https://example.com/t/twin" } },
  { kind: "roleplay", args: { to: "b@example.com", rolePlayName: "Practice", practiceUrl: "https://example.com/s/code" } },
  { kind: "twin", args: { to: "c@example.com", twinName: "Twin", minutes: 0, practiceUrl: "https://example.com/t/twin" } },
];
beforeEach(() => { calls.length = 0; failures.clear(); });

test("sendInviteEmails sends in input order, finishes once and returns the summary", async () => {
  const summary = { sent: 3, failed: [] };
  expect(await sendInviteEmails(emails)).toEqual(summary);
  expect(calls).toEqual([...emails.map((email) => ["send", email]), ["done", summary]]);
});

test("sendInviteEmails catches exhausted steps, reports failures in order and continues", async () => {
  failures.add(emails[0].args.to); failures.add(emails[1].args.to);
  const summary = { sent: 1, failed: [emails[0].args.to, emails[1].args.to] };
  expect(await sendInviteEmails(emails)).toEqual(summary);
  expect(calls).toEqual([
    ["send", emails[0]], ["failed", emails[0].args.to],
    ["send", emails[1]], ["failed", emails[1].args.to],
    ["send", emails[2]], ["done", summary],
  ]);
});

test("sendInviteEmails finishes an empty batch without sending", async () => {
  expect(await sendInviteEmails([])).toEqual({ sent: 0, failed: [] });
  expect(calls).toEqual([["done", { sent: 0, failed: [] }]]);
});
