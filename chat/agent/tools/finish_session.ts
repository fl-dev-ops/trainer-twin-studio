import { z } from "zod";
import { transportTool } from "../lib/workspace-tools";

export default transportTool(
  `Finalize the current session. Call exactly once to end the interview.

WHEN to call:
- session_plan reports isComplete: true AND you already asked the candidate to confirm ending AND they confirmed on this turn.

WHEN NOT to call:
- NEVER in the same turn as any spoken output. The call must be the only action this turn.
- NEVER when asking "Shall we end the session here?" — that is Turn N; wait for their next message.
- NEVER because a round or quota just finished. Confirmation is required after closing feedback.
- NEVER when the candidate says "I'm done" about a task (drawing, coding, answering a question).
- NEVER for pauses, "are you there?", hesitation, or a follow-up question after closing. Answer, then re-ask to confirm ending.
- NEVER before session_plan reports isComplete: true.

Two-beat closing protocol:
1. Turn N (isComplete only): closing feedback, then ask them to confirm ending. No finish_session.
2. Turn N+1: they confirm. finish_session() with NO spoken output.`,
  z.object({}),
);
