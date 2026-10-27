/**
 * After the call: how a finished session is processed (Agent.data.after.report, plans/roleplay-skill.md).
 * Without an `after` block: twins get the twin report, everything else the existing session report.
 */
export type ReportKind = "twin" | "roleplay" | "session";

export function reportKindOf(data: unknown, kind: string | null | undefined): ReportKind {
  const after = data && typeof data === "object" ? (data as { after?: { report?: unknown } }).after : undefined;
  if (after?.report === "twin" || after?.report === "roleplay") return after.report;
  return kind === "TWIN" ? "twin" : "session";
}

/** Workflow-run reports wait for the voice agent's final transcript, which replaces the browser's (may be partial). */
export const usesAgentTranscript = (data: unknown, kind: string | null | undefined) => reportKindOf(data, kind) !== "session";
