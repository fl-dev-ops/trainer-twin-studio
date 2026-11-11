import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as twin from "@/lib/invite/twin";
import * as roleplay from "@/lib/invite/roleplay";
import * as org from "@/lib/invite/org";
import * as credits from "@/lib/invite/credits";
import * as delivery from "@/lib/queue-emails";
import { MinutesError } from "@/lib/minutes";
import { PeopleError } from "@/lib/org-people";
import { addPeople, assignRoleplay, assignTwin, giveCredits, sendEmails } from "@/workflows/steps/learners";

const input = {
  org: { id: "org", slug: "org", name: "Org" }, by: { id: "trainer", name: "Trainer" }, agent: { id: "agent", name: "Agent", data: {} },
  emails: ["learner@example.com"], role: "user" as const, minutes: 30,
};
let spies: { mockRestore(): void }[] = [];
let twinSpy: ReturnType<typeof spyOn<typeof twin, "assignTwinLearners">>;
let roleplaySpy: ReturnType<typeof spyOn<typeof roleplay, "assignRoleplayLearners">>;
let orgSpy: ReturnType<typeof spyOn<typeof org, "addOrgPeople">>;
let creditsSpy: ReturnType<typeof spyOn<typeof credits, "giveLearnerCredits">>;
let queue: ReturnType<typeof spyOn<typeof delivery, "queueEmails">>;
beforeEach(() => {
  twinSpy = spyOn(twin, "assignTwinLearners").mockResolvedValue({ stats: { added: 1, reactivated: 0, skipped: 0, joined: 1 }, emails: [] });
  roleplaySpy = spyOn(roleplay, "assignRoleplayLearners").mockResolvedValue({ stats: { added: 1, resent: 0, skipped: 0, joined: 1 }, emails: [] });
  orgSpy = spyOn(org, "addOrgPeople").mockResolvedValue({ added: 1, already: 0, emails: [] });
  creditsSpy = spyOn(credits, "giveLearnerCredits").mockResolvedValue({ given: [], skipped: [], orgBalanceMinutes: null, emails: [] });
  queue = spyOn(delivery, "queueEmails").mockResolvedValue({ emailFailures: 0, emailsQueued: 0 });
  spies = [twinSpy, roleplaySpy, orgSpy, creditsSpy, queue];
});
afterEach(() => { for (const fn of spies) fn.mockRestore(); });

for (const [name, run, spy] of [
  ["assignTwin", assignTwin, () => twinSpy],
  ["assignRoleplay", assignRoleplay, () => roleplaySpy],
  ["addPeople", addPeople, () => orgSpy],
  ["giveCredits", giveCredits, () => creditsSpy],
] as const) {
  test(`${name} adds ok on success and never retries (it writes members, assignments, credits)`, async () => {
    expect(await run(input as never)).toMatchObject({ ok: true, emails: [] });
    expect(spy()).toHaveBeenCalledTimes(1);
    expect(spy()).toHaveBeenCalledWith(input);
    expect(run.maxRetries).toBe(0);
  });
  test(`${name} turns MinutesError and PeopleError into a refusal and rethrows anything else`, async () => {
    for (const error of [new MinutesError("Need credits", 409), new PeopleError("one_admin", "This organization already has an admin. Add people as team or learner.", 409), new PeopleError("person_disabled", "Disabled", 409)]) {
      spy().mockRejectedValue(error);
      expect(await run(input as never)).toEqual({ ok: false, status: error.status, error: error.message, code: error.code });
    }
    const error = new Error("database unavailable");
    spy().mockRejectedValue(error);
    await expect(run(input as never)).rejects.toBe(error);
    expect(queue).not.toHaveBeenCalled();
  });
}

test("sendEmails hands the batch to queueEmails once, without retrying", async () => {
  expect(await sendEmails("org", [])).toEqual({ emailFailures: 0, emailsQueued: 0 });
  expect(queue).toHaveBeenCalledTimes(1);
  expect(queue).toHaveBeenCalledWith("org", []);
  expect(sendEmails.maxRetries).toBe(0);
});
