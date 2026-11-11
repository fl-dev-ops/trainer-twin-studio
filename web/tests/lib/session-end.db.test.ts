import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as workflow from "workflow";
import * as workflowApi from "workflow/api";
import * as livekit from "@/lib/livekit";
import * as twinSteps from "@/workflows/steps/twin-session-report";
import * as roleplaySteps from "@/workflows/steps/roleplay-session-report";
import * as sessionReports from "@/lib/generate-session-report";
import * as jev from "@/lib/jev";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { claimReport, closeSessionRoom, reportFor } from "@/lib/session-close";
import { chargeCall, takeReport } from "@/workflows/steps/session-end";
import { endTwinSession } from "@/workflows/end-twin-session";
import { endRoleplaySession } from "@/workflows/end-roleplay-session";
import { recordSessionUsage } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

// Real session/claim/ledger writes; only the Workflow runtime, LiveKit and model generation are replaced.
describe.skipIf(!localMinutesDb)("session end workflows (local database)", () => {
  let f: MinutesFixture;
  let twinAssignmentId: string;
  let runId: string;
  const spies: { mockRestore(): void }[] = [];
  let start: ReturnType<typeof spyOn<typeof workflowApi, "start">>;
  let close: ReturnType<typeof spyOn<typeof livekit, "closeLiveKitSession">>;
  let twinGenerate: ReturnType<typeof spyOn<typeof twinSteps, "generateTwinReport">>;
  let roleplayGenerate: ReturnType<typeof spyOn<typeof roleplaySteps, "generateRoleplayReport">>;
  let sessionGenerate: ReturnType<typeof spyOn<typeof sessionReports, "generateSessionReport">>;
  const twinReport = { kind: "twin" as const, summary: "Follow up tonight", topics: ["Follow-up timing"], questions: ["When?"], unanswered: [], generatedAt: "2026-01-01T00:02:00Z" };
  const roleplayReport = { kind: "roleplay" as const, summary: "Asked for next steps", summaryTags: ["Discovery"], keyMoments: [], focusNextTime: "Ask why", score: 80, generatedAt: "2026-01-01T00:02:00Z" };
  const talked = [{ role: "trainer", text: "What happened?" }, { role: "user", text: "When should I follow up?" }];
  const silent = [{ role: "trainer", text: "Hello?" }];

  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    runId = "actual-end-run";
    const assignment = await db.twinAssignment.create({ data: { orgId: f.org.id, agentId: f.twin.id, userId: f.learner.id, minutesLimit: 30, shareCode: `${f.org.id}-twin` } });
    twinAssignmentId = assignment.id;
    start = spyOn(workflowApi, "start").mockResolvedValue({ runId: "started-end-run" } as never);
    close = spyOn(livekit, "closeLiveKitSession").mockResolvedValue(undefined);
    twinGenerate = spyOn(twinSteps, "generateTwinReport").mockResolvedValue(twinReport);
    roleplayGenerate = spyOn(roleplaySteps, "generateRoleplayReport").mockResolvedValue(roleplayReport);
    sessionGenerate = spyOn(sessionReports, "generateSessionReport").mockResolvedValue(null);
    spies.push(start, close, twinGenerate, roleplayGenerate, sessionGenerate,
      spyOn(jev, "decide").mockResolvedValue({}),
      spyOn(workflow, "getWorkflowMetadata").mockImplementation(() => ({ workflowRunId: runId }) as never));
  });
  afterEach(async () => { for (const spy of spies.splice(0).reverse()) spy.mockRestore(); await f?.clean(); });

  test.each([
    ["twin learner completed", "twin", "completed", true, false, "twin"],
    ["twin abandoned with learner speech", "twin", "abandoned", true, false, "twin"],
    ["twin abandoned silent", "twin", "abandoned", false, false, null],
    ["twin calibration completed", "twin", "completed", true, true, null],
    ["twin calibration abandoned", "twin", "abandoned", true, true, null],
    ["roleplay completed", "roleplay", "completed", true, false, "roleplay"],
    ["roleplay abandoned", "roleplay", "abandoned", true, false, null],
    ["v1 scenario completed", "session", "completed", true, false, "session"],
    ["v1 scenario abandoned", "session", "abandoned", true, false, null],
  ] as const)("%s: the end workflow charges once and produces only its eligible report", async (_name, kind, status, spoke, calibration, expected) => {
    if (kind === "roleplay") await db.agent.update({ where: { id: f.roleplay.id }, data: { data: { after: { report: "roleplay" } } } });
    const session = await f.session({
      status, transcript: spoke ? talked : silent, evidence: { transcriptFinal: true },
      ...(kind === "twin" ? { agentId: f.twin.id, agentSlug: f.twin.slug, twinAssignmentId: calibration ? null : twinAssignmentId } : {}),
      ...(calibration ? { userId: f.trainer.id, allowedSeconds: null } : {}),
      livekitRoom: "room-s1", livekitDispatchId: "dispatch-s1", videoEgressId: "egress-s1",
    });
    if (calibration) await db.twinCalibration.create({ data: { sessionId: session.id, createdByUserId: f.trainer.id } });
    expect(await reportFor(session.id)).toBe(expected);
    const run = kind === "twin" ? endTwinSession : endRoleplaySession;
    expect(await run(session.id)).toEqual(calibration ? { status: "ended", calibration: "scored" } : expected ? { status: "ended", report: "completed" } : { status: "ended" });
    if (calibration) expect(await db.twinCalibration.findUniqueOrThrow({ where: { sessionId: session.id } })).toMatchObject({ turns: 1, offTurns: 0, scoredAt: expect.any(Date) });
    expect(close).toHaveBeenCalledWith({ room: "room-s1", dispatchId: "dispatch-s1", videoEgressId: "egress-s1" }, { strict: true });
    expect(twinGenerate).toHaveBeenCalledTimes(expected === "twin" ? 1 : 0);
    expect(roleplayGenerate).toHaveBeenCalledTimes(expected === "roleplay" ? 1 : 0);
    expect(sessionGenerate).toHaveBeenCalledTimes(expected === "session" ? 1 : 0);
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.reportWorkflowRunId).toBe(expected ? "actual-end-run" : null);
    if (expected === "twin") expect(row.report).toEqual(twinReport);
    if (expected === "roleplay") expect(row.report).toEqual(roleplayReport);
    if (expected === "twin" || expected === "roleplay") expect(row.reportStatus).toBe("completed");
    await recordSessionUsage(session.id);
    expect(await db.minuteLedger.count({ where: { sessionId: session.id } })).toBe(calibration ? 0 : 1);
    expect(await run(session.id)).toEqual(calibration ? { status: "ended", calibration: "scored" } : { status: "ended" }); // the same report cannot be claimed again
    expect(twinGenerate).toHaveBeenCalledTimes(expected === "twin" ? 1 : 0);
    expect(roleplayGenerate).toHaveBeenCalledTimes(expected === "roleplay" ? 1 : 0);
    expect(sessionGenerate).toHaveBeenCalledTimes(expected === "session" ? 1 : 0);
  });

  test("takeReport returns null to a second end run and retains the winning run id", async () => {
    const session = await f.session();
    expect(await takeReport(session.id)).toBe("session");
    runId = "second-end-run";
    expect(await takeReport(session.id)).toBeNull();
    expect(await claimReport(session.id, runId)).toBe(false);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, select: { reportStatus: true, reportWorkflowRunId: true } }))
      .toEqual({ reportStatus: "generating", reportWorkflowRunId: "actual-end-run" });
  });

  test("parallel report claims have exactly one winner and store that end run", async () => {
    const session = await f.session();
    const claims = await Promise.all(Array.from({ length: 12 }, (_, n) => claimReport(session.id, `end-run-${n}`)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.reportWorkflowRunId).toBe(`end-run-${claims.indexOf(true)}`);
    expect(row.reportStatus).toBe("generating");
  });

  test.each([null, "none", "failed", "generating", "completed"])("claimReport respects reportStatus %s for ended sessions", async (reportStatus) => {
    const session = await f.session({ reportStatus });
    const eligible = reportStatus === null || reportStatus === "none" || reportStatus === "failed";
    expect(await claimReport(session.id, "end-run")).toBe(eligible);
    const row = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.reportStatus).toBe(eligible ? "generating" : reportStatus);
    expect(row.reportWorkflowRunId).toBe(eligible ? "end-run" : null);
  });

  test.each(["active", "activating", "assigned", "failed", "revoked"])("claimReport refuses %s sessions", async (status) => {
    const session = await f.session({ status });
    expect(await claimReport(session.id, "end-run")).toBe(false);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, select: { reportWorkflowRunId: true } })).toEqual({ reportWorkflowRunId: null });
  });

  test("closeInterviewSession saves transcript/evidence and inline charge before start; duplicate end does not start; abandoned → completed does", async () => {
    const session = await f.session({ status: "active", endedAt: null, startedAt: new Date(Date.now() - 90_000), allowedSeconds: 60, livekitRoom: "room-s1" });
    start.mockImplementation(async () => {
      const row = await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(row.status === "abandoned" || row.status === "completed").toBe(true);
      expect(row.transcript).toEqual(talked);
      expect(row.evidence).toEqual({ transcriptFinal: true });
      expect(await db.minuteLedger.findMany({ where: { sessionId: session.id }, select: { seconds: true } })).toEqual([{ seconds: -60 }]);
      return { runId: "started-end-run" } as never;
    });
    expect(await closeInterviewSession(session.id, "abandoned", { transcript: talked, evidence: { transcriptFinal: true } })).toMatchObject({ previousStatus: "active", finalStatus: "abandoned" });
    const endedAt = (await db.interviewSession.findUniqueOrThrow({ where: { id: session.id } })).endedAt;
    expect(start).toHaveBeenCalledTimes(1);
    await closeInterviewSession(session.id, "abandoned");
    expect(start).toHaveBeenCalledTimes(1);
    expect(await closeInterviewSession(session.id, "completed")).toMatchObject({ previousStatus: "abandoned", finalStatus: "completed" });
    expect(start).toHaveBeenCalledTimes(2);
    await closeInterviewSession(session.id, "completed");
    await closeInterviewSession(session.id, "abandoned"); // cannot downgrade completed
    expect(start).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled(); // asynchronous end workflow owns room closure
    await Promise.all(Array.from({ length: 12 }, () => chargeCall(session.id)));
    expect(await db.minuteLedger.findMany({ where: { sessionId: session.id }, select: { seconds: true } })).toEqual([{ seconds: -60 }]);
    expect(await db.interviewSession.findUniqueOrThrow({ where: { id: session.id }, select: { status: true, endedAt: true } })).toEqual({ status: "completed", endedAt });
  });

  test("missing sessions close/claim/end without starting a workflow", async () => {
    expect(await closeInterviewSession("missing", "completed")).toBeNull();
    expect(await claimReport("missing", "end-run")).toBe(false);
    expect(await takeReport("missing")).toBeNull();
    await closeSessionRoom("missing");
    expect(start).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
});
