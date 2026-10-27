import { sleep } from "workflow";
import { failRoleplayReport, generateRoleplayReport, readRoleplaySession, storeRoleplayReport } from "./roleplay-session-report-steps";

/** How long to wait for the voice agent's full transcript before using the one the browser saved. */
const TRANSCRIPT_CHECKS = 12;
const TRANSCRIPT_INTERVAL = "10s";

/**
 * Report for one completed role play (after.report = "roleplay"): wait (bounded) for the final transcript, score it
 * against the role play's goals and rubric (retried), save it. When generation gives up, the session is marked
 * failed so the page stops waiting. Same shape as the twin report workflow.
 */
export async function roleplaySessionReport(sessionId: string) {
  "use workflow";
  for (let check = 0; check < TRANSCRIPT_CHECKS; check++) {
    const state = await readRoleplaySession(sessionId);
    if (state === "skip") {
      await failRoleplayReport(sessionId);
      return { status: "skipped" as const };
    }
    if (state === "ready") break;
    await sleep(TRANSCRIPT_INTERVAL);
  }
  try {
    const report = await generateRoleplayReport(sessionId);
    await storeRoleplayReport(sessionId, report);
    return { status: "completed" as const };
  } catch (error) {
    await failRoleplayReport(sessionId);
    throw error;
  }
}
