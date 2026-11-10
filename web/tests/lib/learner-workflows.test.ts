import { beforeEach, expect, mock, test } from "bun:test";
import type { OutboundEmail } from "@/workflows/send-emails";

const emails: OutboundEmail[] = [{ kind: "person", idempotencyKey: "added:m1", args: { to: "learner@example.com", orgName: "Org", added: { role: "user", signInUrl: "https://org.example.com/" } } }];
const refusal = { ok: false as const, status: 409, error: "Not enough credits" };
let refused = false;
const assignTwin = mock(async (_input: unknown) => refused ? refusal : { ok: true as const, stats: { added: 1, skipped: 0 }, emails });
const assignRoleplay = mock(async (_input: unknown) => refused ? refusal : { ok: true as const, stats: { added: 1, skipped: 0 }, emails });
const addPeople = mock(async (_input: unknown) => refused ? refusal : { ok: true as const, added: 1, already: 0, emails });
const giveCredits = mock(async (_input: unknown) => refused ? refusal : { ok: true as const, given: ["learner@example.com"], skipped: [], orgBalanceMinutes: 70, emails });
const delivery = { emailFailures: 0, emailsQueued: 1, emailProgress: "signed-token" };
const sendEmails = mock(async (_orgId: string, _emails: OutboundEmail[]) => delivery);
mock.module("@/workflows/steps/learners", () => ({ assignTwin, assignRoleplay, addPeople, giveCredits, sendEmails }));
const { assignTwinToLearners } = await import("@/workflows/assign-twin");
const { assignRoleplayToLearners } = await import("@/workflows/assign-roleplay");
const { addPeopleToOrgFlow } = await import("@/workflows/add-org-people");
const { giveCreditsToLearners } = await import("@/workflows/give-credits");
const input = { org: { id: "org", slug: "org", name: "Org" }, by: { id: "trainer", name: "Trainer" }, agent: { id: "agent", name: "Agent", data: {} }, emails: ["learner@example.com"], role: "user", minutes: 30 };
beforeEach(() => { refused = false; for (const fn of [assignTwin, assignRoleplay, addPeople, giveCredits, sendEmails]) fn.mockClear(); });

for (const [name, run, step, result] of [
  ["assign-twin", assignTwinToLearners, assignTwin, { added: 1, skipped: 0 }],
  ["assign-roleplay", assignRoleplayToLearners, assignRoleplay, { added: 1, skipped: 0 }],
  ["add-org-people", addPeopleToOrgFlow, addPeople, { added: 1, already: 0 }],
  ["give-credits", giveCreditsToLearners, giveCredits, { given: ["learner@example.com"], skipped: [], orgBalanceMinutes: 70 }],
] as const) {
  test(`${name}: the action once, then exactly its emails once`, async () => {
    expect(await run(input as never)).toEqual({ ok: true, ...result, ...delivery } as never);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledWith(input);
    expect(sendEmails).toHaveBeenCalledTimes(1);
    expect(sendEmails).toHaveBeenCalledWith("org", emails);
    expect(step.mock.invocationCallOrder[0]).toBeLessThan(sendEmails.mock.invocationCallOrder[0]);
  });
  test(`${name}: a refusal comes back unchanged and sends nothing`, async () => {
    refused = true;
    expect(await run(input as never)).toBe(refusal as never);
    expect(step).toHaveBeenCalledTimes(1);
    expect(sendEmails).not.toHaveBeenCalled();
  });
}
