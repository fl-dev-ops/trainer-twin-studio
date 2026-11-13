// Workflow: start a session.
// Starts a learner's or team member's call: checks access and minutes (at least MIN_START_MINUTES) and creates the
// session, then for voice opens its LiveKit room and dispatches the agent. Run by POST /api/sessions (lib/run-session-start.ts).

import type { SessionStart, StartSessionInput } from "@/lib/session-activation";
import { connect, open } from "./steps/start-session";

/** A refusal (no access, not enough minutes, …) comes back as `{ ok: false }` for the route to show. */
export async function startSession(input: StartSessionInput): Promise<SessionStart> {
  "use workflow";
  const opened = await open(input);
  if (!opened.ok) return opened;
  if (input.mode === "chat") return { ...opened, conversationToken: opened.session.agentToken };
  return { ...opened, ...(await connect(input, opened.session)) };
}
