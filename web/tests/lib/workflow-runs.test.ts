import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as workflow from "workflow/api";
import * as twin from "@/lib/invite/twin";
import * as org from "@/lib/invite/org";
import * as credits from "@/lib/invite/credits";
import { MinutesError } from "@/lib/minutes";
import { PeopleError } from "@/lib/org-people";
import { runAddOrgPeople, runAndWait, runGiveCredits, runTwinAssign } from "@/lib/workflow-runs";
import { assignTwinToLearners } from "@/workflows/assign-twin";
import { addPeopleToOrgFlow } from "@/workflows/add-org-people";
import { giveCreditsToLearners } from "@/workflows/give-credits";

const input = { org: { id: "org", slug: "org", name: "Org" }, by: { id: "trainer", name: "Trainer" }, agent: { id: "agent", name: "Agent" }, emails: ["learner@example.com"], role: "user" as const, minutes: 30 };
let start: ReturnType<typeof spyOn<typeof workflow, "start">>;
let twinDirect: ReturnType<typeof spyOn<typeof twin, "assignTwinAndInvite">>;
let orgDirect: ReturnType<typeof spyOn<typeof org, "addOrgPeopleAndEmail">>;
let creditsDirect: ReturnType<typeof spyOn<typeof credits, "giveLearnerCreditsAndEmail">>;
let log: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  start = spyOn(workflow, "start").mockResolvedValue({ returnValue: Promise.resolve({ ok: true, added: 1 }) } as never);
  twinDirect = spyOn(twin, "assignTwinAndInvite").mockResolvedValue({ added: 1, skipped: 0, reactivated: 0, joined: 1, emailFailures: 0, emailsQueued: 1 });
  orgDirect = spyOn(org, "addOrgPeopleAndEmail").mockResolvedValue({ added: 1, already: 0, emailFailures: 0, emailsQueued: 1 });
  creditsDirect = spyOn(credits, "giveLearnerCreditsAndEmail").mockResolvedValue({ given: [], skipped: [], orgBalanceMinutes: null, emailFailures: 0, emailsQueued: 0 });
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { for (const fn of [start, twinDirect, orgDirect, creditsDirect, log]) fn.mockRestore(); });

test("runAndWait waits for the run's result and passes the exact workflow and arguments", async () => {
  let resolve!: (value: number) => void;
  start.mockResolvedValue({ returnValue: new Promise<number>((done) => { resolve = done; }) } as never);
  const run = mock(async (_id: string) => 0);
  const direct = mock(async (_id: string) => 2);
  let settled = false;
  const result = runAndWait("test", run, ["org"], direct).then((value) => { settled = true; return value; });
  await new Promise((done) => setTimeout(done, 0));
  expect(settled).toBe(false);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith(run, ["org"]);
  resolve(7);
  expect(await result).toBe(7);
  expect(direct).not.toHaveBeenCalled();
});
test("runAndWait runs the parts here only when the workflow can't start, and never after it started", async () => {
  start.mockRejectedValue(new Error("runtime down"));
  const direct = mock(async (_id: string) => 2);
  expect(await runAndWait("test", async (_id: string) => 0, ["org"], direct)).toBe(2);
  expect(direct).toHaveBeenCalledTimes(1);
  expect(direct).toHaveBeenCalledWith("org");
  const error = new Error("step failed");
  start.mockResolvedValue({ get returnValue() { return Promise.reject(error); } } as never);
  await expect(runAndWait("test", async (_id: string) => 0, ["org"], direct)).rejects.toBe(error);
  expect(direct).toHaveBeenCalledTimes(1);
});
for (const [name, run, definition, fallback] of [
  ["runTwinAssign", runTwinAssign, assignTwinToLearners, () => twinDirect],
  ["runAddOrgPeople", runAddOrgPeople, addPeopleToOrgFlow, () => orgDirect],
  ["runGiveCredits", runGiveCredits, giveCreditsToLearners, () => creditsDirect],
] as const) {
  test(`${name}: a workflow refusal is thrown as MinutesError with its status and message`, async () => {
    start.mockResolvedValue({ returnValue: Promise.resolve({ ok: false, status: 403, error: "An organization has exactly one admin." }) } as never);
    const error = await run(input as never).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MinutesError);
    expect(error).toMatchObject({ status: 403, message: "An organization has exactly one admin." });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(definition, [input]);
    expect(fallback()).not.toHaveBeenCalled();
  });
  test(`${name}: success drops ok; without the workflow a PeopleError is refused the same way`, async () => {
    expect(await run(input as never)).toEqual({ added: 1 } as never);
    start.mockRejectedValue(new Error("runtime down"));
    fallback().mockRejectedValue(new PeopleError("Disabled in this organization", 409));
    await expect(run(input as never)).rejects.toMatchObject({ name: "MinutesError", status: 409, message: "Disabled in this organization" });
    expect(fallback()).toHaveBeenCalledTimes(1);
    expect(fallback()).toHaveBeenCalledWith(input);
  });
}
