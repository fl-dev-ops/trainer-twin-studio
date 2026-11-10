import { type SessionStart, type StartSessionInput, startSessionNow } from "@/lib/session-activation";
import { runAndWait } from "@/lib/workflow-runs";
import { startSession } from "@/workflows/start-session";

/** Starts a call through the start-session workflow (workflows/start-session.ts) and waits for it (lib/workflow-runs.ts). */
export function runSessionStart(input: StartSessionInput): Promise<SessionStart> {
  return runAndWait("start-session", startSession, [input], startSessionNow);
}
