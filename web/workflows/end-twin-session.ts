// Workflow: end a twin session.
// After a twin call ends (learner or calibration): closes its LiveKit room, charges the call (learner credits, or the
// org's for admin and team), then a learner call's report: waits for the voice agent's final transcript and writes
// the summary, topics and questions. Started by lib/session-end.ts; steps in ./steps/session-end.ts and
// ./steps/twin-session-report.ts.

import { sleep } from "workflow";
import { chargeCall, closeRoom, takeReport } from "./steps/session-end";
import { failTwinReport, generateTwinReport, readTwinSession, storeTwinReport } from "./steps/twin-session-report";

/** How long to wait for the voice agent's full transcript before using the one the browser saved. */
const TRANSCRIPT_CHECKS = 12;
const TRANSCRIPT_INTERVAL = "10s";

export async function endTwinSession(sessionId: string) {
  "use workflow";
  // A room that won't close (LiveKit down past the retries) doesn't hold up the charge and the report.
  await closeRoom(sessionId).catch(() => undefined);
  await chargeCall(sessionId);
  // Learner calls only (completed, or abandoned when the learner spoke); calibrations save their ratings in the call.
  if ((await takeReport(sessionId)) !== "twin") return { status: "ended" as const };
  for (let check = 0; check < TRANSCRIPT_CHECKS; check++) {
    const state = await readTwinSession(sessionId);
    if (state === "skip") {
      await failTwinReport(sessionId);
      return { status: "ended" as const, report: "skipped" as const };
    }
    if (state === "ready") break;
    await sleep(TRANSCRIPT_INTERVAL);
  }
  try {
    const report = await generateTwinReport(sessionId);
    await storeTwinReport(sessionId, report);
    return { status: "ended" as const, report: "completed" as const };
  } catch (error) {
    // When generation gives up, the session is marked failed so the page stops waiting.
    await failTwinReport(sessionId);
    throw error;
  }
}
