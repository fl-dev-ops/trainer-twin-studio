import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  `End the current session. Call exactly once, after the learner confirmed they are done.

WHEN to call:
- You already closed and asked the learner to confirm they are done, and on their next message they confirmed.

WHEN NOT to call:
- NEVER in the same turn as spoken output.
- NEVER when asking whether they are done; that is the turn before. Wait for their next message.
- NEVER when the learner says "I'm done" about a task (drawing, coding, answering a question).
- NEVER for pauses, "are you there?", hesitation, or a follow-up question after closing. Answer, then ask again.

Two-beat closing:
1. Turn N: close, then ask them to confirm they are done. No finish_session.
2. Turn N+1: if they confirm, call finish_session() with NO spoken output.`,
  z.object({}),
);
