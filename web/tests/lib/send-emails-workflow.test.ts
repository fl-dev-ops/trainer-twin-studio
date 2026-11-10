import { beforeEach, expect, mock, test } from "bun:test";
import type { OutboundEmail } from "@/workflows/send-emails";

const calls: unknown[][] = [];
const failures = new Set<string>();
mock.module("@/workflows/steps/send-emails", () => ({
  sendOne: async (email: OutboundEmail) => {
    calls.push(["send", email]);
    if (failures.has(email.args.to)) throw new Error("retries exhausted");
  },
  markFailed: async (to: string) => { calls.push(["failed", to]); },
  finish: async (summary: unknown) => { calls.push(["done", summary]); },
}));
const { deliverEmails } = await import("@/workflows/send-emails");
const emails: OutboundEmail[] = [
  { kind: "person", args: { to: "a@example.com", orgName: "Org", credits: { added: 5, balance: 35 } } },
  { kind: "person", args: { to: "b@example.com", orgName: "Org", twin: { name: "Twin", url: "https://x/t/twin" } } },
  { kind: "orgCredits", args: { to: "c@example.com", orgName: "Org", added: 1, balance: 1, creditsUrl: "https://x/credits" } },
];
beforeEach(() => { calls.length = 0; failures.clear(); });

test("deliverEmails sends each in order, then finishes once with the summary", async () => {
  expect(await deliverEmails(emails)).toEqual({ sent: 3, failed: [] });
  expect(calls).toEqual([...emails.map((email) => ["send", email]), ["done", { sent: 3, failed: [] }]]);
});

test("one email failing after its retries doesn't stop the rest", async () => {
  failures.add("a@example.com");
  const summary = { sent: 2, failed: ["a@example.com"] };
  expect(await deliverEmails(emails)).toEqual(summary);
  expect(calls).toEqual([["send", emails[0]], ["failed", "a@example.com"], ["send", emails[1]], ["send", emails[2]], ["done", summary]]);
});

test("an empty batch just finishes", async () => {
  expect(await deliverEmails([])).toEqual({ sent: 0, failed: [] });
  expect(calls).toEqual([["done", { sent: 0, failed: [] }]]);
});
