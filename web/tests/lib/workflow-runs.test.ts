import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as workflow from "workflow/api";
import * as twin from "@/lib/invite/twin";
import * as org from "@/lib/invite/org";
import { MinutesError } from "@/lib/minutes";
import { runAndWait, runTwinAssign, runOrgInvite } from "@/lib/workflow-runs";
import { assignTwinToLearners } from "@/workflows/assign-twin";
import { inviteOrgLearners } from "@/workflows/invite-org-learners";

const input = { org: { id: "org", slug: "org", name: "Org" }, by: { id: "trainer", name: "Trainer" }, agent: { id: "agent", name: "Agent" }, emails: ["learner@example.com"], minutes: 30 };
let start: ReturnType<typeof spyOn<typeof workflow, "start">>;
let twinDirect: ReturnType<typeof spyOn<typeof twin, "assignTwinAndInvite">>;
let orgDirect: ReturnType<typeof spyOn<typeof org, "inviteLearners">>;
let log: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  start = spyOn(workflow, "start").mockResolvedValue({ returnValue: Promise.resolve({ ok: true, invited: 1 }) } as never);
  twinDirect = spyOn(twin, "assignTwinAndInvite").mockResolvedValue({ added: 1, skipped: 0, reactivated: 0, emailFailures: 0, emailsQueued: 1 });
  orgDirect = spyOn(org, "inviteLearners").mockResolvedValue({ invited: 1, failed: [], emailFailures: 0, emailsQueued: 1 });
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { for (const fn of [start, twinDirect, orgDirect, log]) fn.mockRestore(); });

test("runAndWait awaits returnValue and passes the exact workflow and arguments", async () => {
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
test("runAndWait uses direct once only when start throws", async () => {
  start.mockRejectedValue(new Error("runtime down"));
  const direct = mock(async (_id: string) => 2);
  expect(await runAndWait("test", async (_id: string) => 0, ["org"], direct)).toBe(2);
  expect(direct).toHaveBeenCalledTimes(1);
  expect(direct).toHaveBeenCalledWith("org");
});
test("runAndWait never repeats work after a started workflow rejects", async () => {
  const error = new Error("step failed");
  start.mockResolvedValue({ get returnValue() { return Promise.reject(error); } } as never);
  const direct = mock(async () => 2);
  await expect(runAndWait("test", async () => 0, [], direct)).rejects.toBe(error);
  expect(direct).not.toHaveBeenCalled();
});
for (const [name, run, definition, fallback] of [
  ["runTwinAssign", runTwinAssign, assignTwinToLearners, () => twinDirect],
  ["runOrgInvite", runOrgInvite, inviteOrgLearners, () => orgDirect],
] as const) {
  test(`${name} maps workflow refusal to MinutesError with original status/message`, async () => {
    start.mockResolvedValue({ returnValue: Promise.resolve({ ok: false, status: 409, error: "Not enough credits" }) } as never);
    const error = await run(input).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MinutesError);
    expect(error).toMatchObject({ status: 409, message: "Not enough credits" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(definition, [input]);
    expect(fallback()).not.toHaveBeenCalled();
  });
  test(`${name} removes ok from success and maps direct refusal too`, async () => {
    expect(await run(input)).toEqual({ invited: 1 });
    start.mockRejectedValue(new Error("runtime down"));
    fallback().mockRejectedValue(new org.InviteError("Already a member", 400));
    await expect(run(input)).rejects.toMatchObject({ name: "MinutesError", status: 400, message: "Already a member" });
    expect(fallback()).toHaveBeenCalledTimes(1);
    expect(fallback()).toHaveBeenCalledWith(input);
  });
}
