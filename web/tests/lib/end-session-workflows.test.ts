import { beforeEach, expect, mock, test } from "bun:test";

const calls: unknown[][] = [];
let kind: "twin" | "roleplay" | "session" | null = "twin";
let reads: ("ready" | "waiting" | "skip")[] = [];
let closeFails = false;
let chargeFails = false;
let failAt: "generate" | "store" | null = null;
const report = { summary: "Follow up this evening" };
const step = (name: string) => async (...args: unknown[]) => {
  calls.push([name, ...args]);
  if ((name === "close" && closeFails) || (name === "charge" && chargeFails) || name === failAt) throw new Error(`${name} failed`);
};
mock.module("workflow", () => ({ sleep: step("sleep") }));
mock.module("@/workflows/steps/session-end", () => ({
  closeRoom: step("close"), chargeCall: step("charge"), writeSessionReport: step("session-report"),
  takeReport: async (id: string) => { calls.push(["take", id]); return kind; },
}));
const reportSteps = {
  read: async (id: string) => { calls.push(["read", id]); return reads.shift() ?? "ready"; },
  generate: async (id: string) => { await step("generate")(id); return report; },
  store: step("store"), fail: step("fail"),
};
mock.module("@/workflows/steps/twin-session-report", () => ({ readTwinSession: reportSteps.read, generateTwinReport: reportSteps.generate, storeTwinReport: reportSteps.store, failTwinReport: reportSteps.fail }));
mock.module("@/workflows/steps/roleplay-session-report", () => ({ readRoleplaySession: reportSteps.read, generateRoleplayReport: reportSteps.generate, storeRoleplayReport: reportSteps.store, failRoleplayReport: reportSteps.fail }));
const { endTwinSession } = await import("@/workflows/end-twin-session");
const { endRoleplaySession } = await import("@/workflows/end-roleplay-session");
const ending = [["close", "s1"], ["charge", "s1"], ["take", "s1"]];
const reporting = [["read", "s1"], ["generate", "s1"], ["store", "s1", report]];

beforeEach(() => { calls.length = 0; kind = "twin"; reads = []; closeFails = false; chargeFails = false; failAt = null; });

for (const [name, run, reportKind] of [["twin", endTwinSession, "twin"], ["roleplay", endRoleplaySession, "roleplay"]] as const) {
  test(`${name}: closes, charges, claims, then generates and stores the report`, async () => {
    kind = reportKind;
    expect(await run("s1")).toEqual({ status: "ended", report: "completed" });
    expect(calls).toEqual([...ending, ...reporting]);
  });
  test(`${name}: no report claim means just close and charge`, async () => {
    kind = null;
    expect(await run("s1")).toEqual({ status: "ended" });
    expect(calls).toEqual(ending);
  });
  test(`${name}: exhausted closeRoom retries do not stop charging or reporting`, async () => {
    kind = reportKind;
    closeFails = true;
    expect(await run("s1")).toEqual({ status: "ended", report: "completed" });
    expect(calls).toEqual([...ending, ...reporting]);
  });
  test(`${name}: a charge failure propagates without claiming a report`, async () => {
    chargeFails = true;
    await expect(run("s1")).rejects.toThrow("charge failed");
    expect(calls).toEqual(ending.slice(0, 2));
  });
  test(`${name}: waits for the final transcript before generating`, async () => {
    kind = reportKind;
    reads = ["waiting", "waiting", "ready"];
    expect(await run("s1")).toEqual({ status: "ended", report: "completed" });
    expect(calls).toEqual([...ending, ["read", "s1"], ["sleep", "10s"], ["read", "s1"], ["sleep", "10s"], ...reporting]);
  });
  test(`${name}: after 12 ten-second waits it generates from the available transcript`, async () => {
    kind = reportKind;
    reads = Array(12).fill("waiting");
    expect(await run("s1")).toEqual({ status: "ended", report: "completed" });
    expect(calls).toEqual([...ending, ...Array.from({ length: 12 }, () => [["read", "s1"], ["sleep", "10s"]]).flat(), ...reporting.slice(1)]);
  });
  test(`${name}: ineligible input is marked failed/skipped and is not generated`, async () => {
    kind = reportKind;
    reads = ["skip"];
    expect(await run("s1")).toEqual({ status: "ended", report: "skipped" });
    expect(calls).toEqual([...ending, ["read", "s1"], ["fail", "s1"]]);
  });
  test.each(["generate", "store"] as const)(`${name}: %s failure marks the report failed and rethrows`, async (stage) => {
    kind = reportKind;
    failAt = stage;
    await expect(run("s1")).rejects.toThrow(`${stage} failed`);
    expect(calls).toEqual([...ending, ...reporting.slice(0, stage === "generate" ? 2 : 3), ["fail", "s1"]]);
  });
}

test("v1 scenario completion writes its session report without transcript polling or roleplay scoring", async () => {
  kind = "session";
  expect(await endRoleplaySession("s1")).toEqual({ status: "ended", report: "completed" });
  expect(calls).toEqual([...ending, ["session-report", "s1"]]);
});
