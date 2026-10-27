import { FatalError, RetryableError } from "workflow";
import { ReportError } from "@/lib/report-model";
import {
  buildRoleplayReport,
  loadRoleplayReportInput,
  markRoleplayReportFailed,
  type RoleplayReport,
  saveRoleplayReport,
} from "@/lib/roleplay/session-report";

/**
 * Steps of the roleplay-session-report workflow. Each is checkpointed: a retry of saving reuses the stored
 * model result instead of calling the model again.
 */

/** "ready": go; "waiting": the agent's final transcript has not arrived; "skip": not a completed role play. */
export async function readRoleplaySession(sessionId: string): Promise<"ready" | "waiting" | "skip"> {
  "use step";
  const input = await loadRoleplayReportInput(sessionId);
  if (!input.eligible) return "skip";
  return input.transcriptFinal ? "ready" : "waiting";
}

export async function generateRoleplayReport(sessionId: string): Promise<RoleplayReport> {
  "use step";
  const input = await loadRoleplayReportInput(sessionId);
  try {
    return await buildRoleplayReport(sessionId, input);
  } catch (error) {
    if (error instanceof ReportError) {
      if (error.fatal) throw new FatalError(error.message);
      if (error.retryAfterMs) throw new RetryableError(error.message, { retryAfter: error.retryAfterMs });
    }
    throw error; // network errors, timeouts, bad model output: retried with the default policy
  }
}
generateRoleplayReport.maxRetries = 3;

export async function storeRoleplayReport(sessionId: string, report: RoleplayReport) {
  "use step";
  await saveRoleplayReport(sessionId, report);
}

export async function failRoleplayReport(sessionId: string) {
  "use step";
  await markRoleplayReportFailed(sessionId);
}
