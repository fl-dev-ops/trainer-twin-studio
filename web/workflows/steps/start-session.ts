import { connectVoice, openSession, type OpenedSession, type StartSessionInput } from "@/lib/session-activation";

/**
 * Steps of the start-session workflow (../start-session.ts). Neither is retried: a repeated agent dispatch would put
 * two agents in one call, and a person waiting on the page should see a failure at once and try again.
 */

/** Access, minutes and the session row (lib/interview-sessions.ts activateSession). */
export async function open(input: StartSessionInput) {
  "use step";
  return openSession(input);
}
open.maxRetries = 0;

/** The LiveKit room, the agent's dispatch and the recording; closes the session when that fails. */
export async function connect(input: StartSessionInput, session: OpenedSession) {
  "use step";
  return connectVoice(input, session);
}
connect.maxRetries = 0;
