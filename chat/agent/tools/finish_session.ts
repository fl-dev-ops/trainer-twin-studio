import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  `Finalize the current session. Call exactly once to end the interview.

WHEN to call:
- All session_plan rounds are "done" AND closing feedback has already been spoken AND the candidate has responded or acknowledged.

WHEN NOT to call:
- NEVER in the same turn as closing feedback or any other speech. Speak your farewell first, wait for the candidate to respond, then call finish_session on the next turn with no additional speech.
- NEVER when the candidate says "I'm done" about a task (drawing, coding, answering a question). That means they finished the task, not the session.
- NEVER for pauses, hesitation, temporary silence, or topic transitions.
- NEVER before session_plan reports isComplete: true.

Two-beat closing protocol:
1. Turn N: Deliver closing feedback and farewell. Do NOT call finish_session.
2. Turn N+1: Candidate responds. Call finish_session() with NO spoken output.`,
  z.object({}),
);
