import { sleep } from "workflow";
import { failTwinReport, generateTwinReport, readTwinSession, storeTwinReport } from "./twin-session-report-steps";

/** How long to wait for the voice agent's full transcript before using the one the browser saved. */
const TRANSCRIPT_CHECKS = 12;
const TRANSCRIPT_INTERVAL = "10s";

/**
 * Report for one completed learner twin session: wait (bounded) for the final transcript, generate the report
 * (retried), save it. When generation gives up, the session is marked failed so the page stops waiting.
 */
export async function twinSessionReport(sessionId: string) {
  "use workflow";
  for (let check = 0; check < TRANSCRIPT_CHECKS; check++) {
    const state = await readTwinSession(sessionId);
    if (state === "skip") {
      await failTwinReport(sessionId);
      return { status: "skipped" as const };
    }
    if (state === "ready") break;
    await sleep(TRANSCRIPT_INTERVAL);
  }
  try {
    const report = await generateTwinReport(sessionId);
    await storeTwinReport(sessionId, report);
    return { status: "completed" as const };
  } catch (error) {
    await failTwinReport(sessionId);
    throw error;
  }
}
