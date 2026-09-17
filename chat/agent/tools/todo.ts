import { todo } from "eve/tools/defaults";
import { defineTool } from "eve/tools";

/**
 * Re-enabled Eve's todo as the session progress tracker.
 * The prompt instructs the model to initialize it from INTERVIEW SETTINGS
 * on [OPENING] and update after each main question / follow-up.
 * Eve's todo survives context compaction.
 */
export default defineTool({
  ...todo,
  description: `Session progress tracker. Use this tool to plan and track interview questions across the session.

MUST call on [OPENING] to initialize the session plan from INTERVIEW SETTINGS:
- Create one item per main question slot (e.g. "system-design question 1 of 2", "verbal question 1 of 2").
- Set all items to pending initially.

MUST call after each main question to update progress:
- Mark the current question in_progress when you pose it.
- Mark it completed after the candidate answers and follow-ups are exhausted.
- When all items are completed, call finish_session.

Call without todos to read the current plan and counts. Call with todos to replace the full list.
Each item has: content (description), priority (high/medium/low), status (pending/in_progress/completed/cancelled).`,
});
