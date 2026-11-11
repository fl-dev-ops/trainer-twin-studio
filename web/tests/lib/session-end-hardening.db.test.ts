import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as workflowApi from "workflow/api";
import * as livekit from "@/lib/livekit";
import { startSessionEnd } from "@/lib/session-end";
import { sweepStaleCalls } from "@/lib/session-lifecycle";
import { setMemberDisabled } from "@/lib/members";
import { claimReport } from "@/lib/session-close";
import { finalizeSessionRow } from "@/lib/interview-sessions";
import type { Prisma } from "@/lib/generated/prisma/client";
import { failStaleReports, markReportFailed, reportStateOf, saveReport } from "@/lib/report-model";
import { localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import * as database from "@/lib/db";

let scopedOrg: string;
const selections: unknown[] = [];
// Prisma model delegates return fresh proxies, so use its query extension rather than spying on delegate properties.
const db = database.db.$extends({ query: { interviewSession: {
  async findMany({ args, query }) {
    selections.push(args);
    return query({ ...args, where: { ...args.where, orgId: scopedOrg } });
  },
  async updateMany({ args, query }) {
    return query({ ...args, where: { ...args.where, orgId: scopedOrg } });
  },
} } });
mock.module("@/lib/db", () => ({ ...database, db }));

describe.skipIf(!localMinutesDb)("Module 5 end work and report ownership (real database)", () => {
  let f: MinutesFixture;
  let start: ReturnType<typeof spyOn<typeof workflowApi, "start">>;
  const spies: { mockRestore(): void }[] = [];
  beforeEach(async () => {
    f = minutesFixture(); scopedOrg = f.org.id; selections.length = 0; await f.create();
    start = spyOn(workflowApi, "start").mockResolvedValue({ runId: "end-run" } as never);
    spies.push(start, spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined), spyOn(console, "error").mockImplementation(() => {}));
  });
  afterEach(async () => { for (const spy of spies.splice(0).reverse()) spy.mockRestore(); await f.clean(); });
  const ended = (age: number, extra: Parameters<MinutesFixture["session"]>[0] = {}) => f.session({ endedAt: new Date(Date.now() - age), endWorkAt: null, ...extra });
  test("finalizeSessionRow acquires a real FOR UPDATE row lock before its merge read", async () => {
    const call = await ended(120_000);
    const operations: string[] = [];
    await db.$transaction(async (tx) => {
      const guarded = new Proxy(tx, { get(target, key, receiver) {
        if (key === "$queryRaw") return async (query: TemplateStringsArray, ...values: unknown[]) => {
          expect(query.join(" ")).toContain("FOR UPDATE"); operations.push("lock");
          return target.$queryRaw(query, ...values);
        };
        if (key === "interviewSession") return new Proxy(target.interviewSession, { get(model, method) {
          if (method === "findUnique") return async (args: Prisma.InterviewSessionFindUniqueArgs) => {
            expect(operations).toEqual(["lock"]); operations.push("read");
            return model.findUnique(args);
          };
          return Reflect.get(model, method);
        } });
        return Reflect.get(target, key, receiver);
      } });
      await finalizeSessionRow({ sessionId: call.id, requestedStatus: "abandoned" }, guarded);
    });
    expect(operations).toEqual(["lock", "read"]);
  });
  test("endWorkAt is set only after workflow start succeeds", async () => {
    const call = await ended(120_000);
    start.mockImplementation(async () => {
      expect((await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).endWorkAt).toBeNull();
      return { runId: "end-run" } as never;
    });
    await startSessionEnd(call.id);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).endWorkAt).toBeInstanceOf(Date);
    expect(start).toHaveBeenCalledTimes(1);
  });
  test("workflow start failure leaves endWorkAt null, closes/charges and can be retried", async () => {
    const call = await ended(120_000);
    start.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(startSessionEnd(call.id)).resolves.toBeUndefined();
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).endWorkAt).toBeNull();
    expect(await db.minuteLedger.count({ where: { sessionId: call.id } })).toBe(1);
    await startSessionEnd(call.id);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).endWorkAt).toBeInstanceOf(Date);
    expect(await db.minuteLedger.count({ where: { sessionId: call.id } })).toBe(1);
  });
  test("sweep re-starts completed/abandoned unstarted work within 1 min–24 h, skips old/backfilled/recent/other statuses, and fails stale reports", async () => {
    const retry = await Promise.all([ended(120_000), ended(23 * 60 * 60_000, { status: "abandoned" })]);
    const keep = await Promise.all([
      ended(25 * 60 * 60_000), ended(120_000, { endWorkAt: new Date() }), ended(15_000),
      ended(120_000, { status: "failed" }), ended(120_000, { status: "revoked" }), ended(120_000, { endedAt: null }),
    ]);
    const stale = await ended(31 * 60_000, { reportStatus: "generating", reportWorkflowRunId: "slow-run", endWorkAt: new Date() });
    spies.push(spyOn(db, "$queryRaw").mockResolvedValue([]));
    expect(await sweepStaleCalls()).toBe(0);
    expect(start.mock.calls.map(([, ids]) => ids[0]).sort()).toEqual(retry.map(({ id }) => id).sort());
    expect(selections[0]).toMatchObject({ take: 200, where: { endWorkAt: null, status: { in: ["completed", "abandoned"] } } });
    for (const call of retry) expect((await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).endWorkAt).toBeInstanceOf(Date);
    for (const call of keep) expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(call);
    expect((await db.interviewSession.findUniqueOrThrow({ where: { id: stale.id } })).reportStatus).toBe("failed");
    expect(await db.interviewSession.count({ where: { orgId: f.org.id, status: { in: ["completed", "abandoned"] }, endWorkAt: null, endedAt: { gt: new Date(Date.now() - 24 * 60 * 60_000), lt: new Date(Date.now() - 60 * 60_000) } } })).toBe(0);
    start.mockClear(); await sweepStaleCalls(); expect(start).not.toHaveBeenCalled();
  });
  test("disable re-starts only that person's recent unstarted completed/abandoned calls", async () => {
    const retry = await Promise.all([ended(120_000), ended(120_000, { status: "abandoned" })]);
    const keep = await Promise.all([ended(25 * 60 * 60_000), ended(120_000, { endWorkAt: new Date() }), ended(120_000, { userId: f.trainer.id }), ended(120_000, { status: "failed" })]);
    await setMemberDisabled({ orgId: f.org.id, memberId: `${f.learner.id}-member`, actorUserId: f.trainer.id, disabled: true });
    expect(start.mock.calls.map(([, ids]) => ids[0]).sort()).toEqual(retry.map(({ id }) => id).sort());
    for (const call of retry) expect((await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).endWorkAt).toBeInstanceOf(Date);
    for (const call of keep) expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(call);
  });
  test("a different run cannot save or fail a generating report; the winning run saves only once", async () => {
    const call = await ended(120_000);
    expect(await claimReport(call.id, "winner")).toBe(true);
    const claimed = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    await saveReport(call.id, "other-run", { summary: "wrong" }); await markReportFailed(call.id, "other-run");
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(claimed);
    await saveReport(call.id, "winner", { summary: "right" });
    await saveReport(call.id, "winner", { summary: "late overwrite" }); await markReportFailed(call.id, "winner");
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ reportStatus: "completed", report: { summary: "right" }, reportWorkflowRunId: "winner" });
  });
  test("failed reports cannot be re-claimed or overwritten even by their original run", async () => {
    const call = await ended(120_000);
    await claimReport(call.id, "winner"); await markReportFailed(call.id, "winner");
    const failed = await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } });
    expect(await claimReport(call.id, "new-run")).toBe(false);
    await saveReport(call.id, "winner", { summary: "late" });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(failed);
  });
  test("stale generating reports show unavailable, fail in the sweep helper and refuse a late save", async () => {
    const stale = await ended(31 * 60_000, { reportStatus: "generating", reportWorkflowRunId: "slow" });
    const recent = await ended(29 * 60_000, { reportStatus: "generating", reportWorkflowRunId: "fast" });
    const live = await ended(0, { endedAt: null, reportStatus: "generating" });
    const completed = await ended(31 * 60_000, { reportStatus: "completed", report: { summary: "saved" } });
    expect(reportStateOf(stale, () => false)).toBe("unavailable"); expect(reportStateOf(recent, () => false)).toBe("pending");
    expect(await failStaleReports()).toBe(1);
    await saveReport(stale.id, "slow", { summary: "late" });
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ reportStatus: "failed", report: null });
    for (const call of [recent, live, completed]) expect(await db.interviewSession.findUniqueOrThrow({ where: { id: call.id } })).toEqual(call);
  });
});
