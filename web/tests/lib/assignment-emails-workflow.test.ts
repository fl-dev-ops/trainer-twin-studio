import { beforeEach, expect, mock, test } from "bun:test";
import type { AssignmentEmail } from "@/workflows/assignment-emails";

const calls: unknown[][] = [];
const failures = new Set<string>();
mock.module("@/workflows/assignment-emails-steps", () => ({
  sendOne: async (email: AssignmentEmail) => {
    calls.push(["send", email]);
    if (failures.has(email.args.to)) throw new Error("retries exhausted");
  },
  markFailed: async (to: string) => { calls.push(["failed", to]); },
  finish: async (summary: unknown) => { calls.push(["done", summary]); },
}));
const { sendAssignmentEmails } = await import("@/workflows/assignment-emails");
const emails: AssignmentEmail[] = [
  { kind: "twin", args: { to: "a@example.com", twinName: "Twin", minutes: 30, practiceUrl: "https://example.com/t/twin" } },
  { kind: "roleplay", args: { to: "b@example.com", rolePlayName: "Practice", practiceUrl: "https://example.com/s/code" } },
  { kind: "twin", args: { to: "c@example.com", twinName: "Twin", minutes: 0, practiceUrl: "https://example.com/t/twin" } },
];
beforeEach(() => { calls.length = 0; failures.clear(); });

test("sendAssignmentEmails sends in input order, finishes once and returns the summary", async () => {
  const summary = { sent: 3, failed: [] };
  expect(await sendAssignmentEmails(emails)).toEqual(summary);
  expect(calls).toEqual([...emails.map((email) => ["send", email]), ["done", summary]]);
});

test("sendAssignmentEmails catches exhausted steps, reports failures in order and continues", async () => {
  failures.add(emails[0].args.to); failures.add(emails[1].args.to);
  const summary = { sent: 1, failed: [emails[0].args.to, emails[1].args.to] };
  expect(await sendAssignmentEmails(emails)).toEqual(summary);
  expect(calls).toEqual([
    ["send", emails[0]], ["failed", emails[0].args.to],
    ["send", emails[1]], ["failed", emails[1].args.to],
    ["send", emails[2]], ["done", summary],
  ]);
});

test("sendAssignmentEmails finishes an empty batch without sending", async () => {
  expect(await sendAssignmentEmails([])).toEqual({ sent: 0, failed: [] });
  expect(calls).toEqual([["done", { sent: 0, failed: [] }]]);
});
