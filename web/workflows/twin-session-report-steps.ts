import { FatalError, RetryableError } from "workflow";
import {
  buildTwinReport,
  loadTwinReportInput,
  markTwinReportFailed,
  saveTwinReport,
  type TwinReport,
  TwinReportError,
} from "@/lib/twin/session-report";

/**
 * Steps of the twin-session-report workflow. Each is checkpointed: a retry of saving reuses the stored
 * model result instead of calling the model again.
 */

/** "ready": go; "waiting": the agent's final transcript has not arrived; "skip": not a learner twin session. */
export async function readTwinSession(sessionId: string): Promise<"ready" | "waiting" | "skip"> {
  "use step";
  const input = await loadTwinReportInput(sessionId);
  if (!input.eligible) return "skip";
  return input.transcriptFinal ? "ready" : "waiting";
}

export async function generateTwinReport(sessionId: string): Promise<TwinReport> {
  "use step";
  const input = await loadTwinReportInput(sessionId);
  try {
    return await buildTwinReport(sessionId, input);
  } catch (error) {
    if (error instanceof TwinReportError) {
      if (error.fatal) throw new FatalError(error.message);
      if (error.retryAfterMs) throw new RetryableError(error.message, { retryAfter: error.retryAfterMs });
    }
    throw error; // network errors, timeouts, bad model output: retried with the default policy
  }
}
generateTwinReport.maxRetries = 3;

export async function storeTwinReport(sessionId: string, report: TwinReport) {
  "use step";
  await saveTwinReport(sessionId, report);
}

export async function failTwinReport(sessionId: string) {
  "use step";
  await markTwinReportFailed(sessionId);
}
