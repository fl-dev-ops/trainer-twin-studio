import { getWorkflowMetadata } from "workflow";
import { generateSessionReport } from "@/lib/generate-session-report";
import { recordSessionUsage } from "@/lib/minutes";
import { claimReport, closeSessionRoom, reportFor } from "@/lib/session-close";

/**
 * Steps shared by the end-twin-session and end-roleplay-session workflows (../end-twin-session.ts,
 * ../end-roleplay-session.ts). Each is safe to repeat: a retry, or a second end run for the same session, changes
 * nothing that's already done.
 */

/** Closes the LiveKit room, the agent's dispatch and the recording (retried; already gone counts as done). */
export async function closeRoom(sessionId: string): Promise<void> {
  "use step";
  await closeSessionRoom(sessionId);
}

/** The call's seconds off the learner's credits, or the org's for admin and team (one usage row per session). */
export async function chargeCall(sessionId: string): Promise<void> {
  "use step";
  await recordSessionUsage(sessionId);
}

/** Which report this session gets, claimed for this run; null when none (or another run already has it). */
export async function takeReport(sessionId: string): Promise<"twin" | "roleplay" | "session" | null> {
  "use step";
  const report = await reportFor(sessionId);
  if (!report) return null;
  return (await claimReport(sessionId, getWorkflowMetadata().workflowRunId)) ? report : null;
}

/** A v1 scenario's report (lib/generate-session-report.ts marks it ready or failed itself). */
export async function writeSessionReport(sessionId: string): Promise<void> {
  "use step";
  await generateSessionReport(sessionId);
}
writeSessionReport.maxRetries = 1;
