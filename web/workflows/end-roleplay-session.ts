// Workflow: end a role-play session.
// After a role play ends: closes its LiveKit room, charges the call (learner credits, or the org's for admin and
// team), then, when it was completed, its report: a builder role play is scored against its goals and rubric after
// the voice agent's final transcript; a v1 scenario gets its session report. Started by lib/session-end.ts; steps in
// ./steps/session-end.ts and ./steps/roleplay-session-report.ts.

import { sleep } from "workflow";
import { chargeCall, closeRoom, takeReport, writeSessionReport } from "./steps/session-end";
import { failRoleplayReport, generateRoleplayReport, readRoleplaySession, storeRoleplayReport } from "./steps/roleplay-session-report";

/** How long to wait for the voice agent's full transcript before using the one the browser saved. */
const TRANSCRIPT_CHECKS = 12;
const TRANSCRIPT_INTERVAL = "10s";

export async function endRoleplaySession(sessionId: string) {
  "use workflow";
  // A room that won't close (LiveKit down past the retries) doesn't hold up the charge and the report.
  await closeRoom(sessionId).catch(() => undefined);
  await chargeCall(sessionId);
  const report = await takeReport(sessionId);
  if (report === "session") {
    await writeSessionReport(sessionId);
    return { status: "ended" as const, report: "completed" as const };
  }
  if (report !== "roleplay") return { status: "ended" as const };
  for (let check = 0; check < TRANSCRIPT_CHECKS; check++) {
    const state = await readRoleplaySession(sessionId);
    if (state === "skip") {
      await failRoleplayReport(sessionId);
      return { status: "ended" as const, report: "skipped" as const };
    }
    if (state === "ready") break;
    await sleep(TRANSCRIPT_INTERVAL);
  }
  try {
    const scored = await generateRoleplayReport(sessionId);
    await storeRoleplayReport(sessionId, scored);
    return { status: "ended" as const, report: "completed" as const };
  } catch (error) {
    await failRoleplayReport(sessionId);
    throw error;
  }
}
