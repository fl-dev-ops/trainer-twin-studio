/**
 * Voice-only overlap of speech with tool calls. Gemini returns either tool calls or text, so
 * whatever the trainer says in a tool-calling response travels inside the tool input and the
 * bridge speaks it as soon as the call is requested:
 * - `start_resume_question.question`: spoken while the highlight runs; the model's repeat is
 *   dropped once the highlight is confirmed.
 * - `session_plan.reply` (one-call turns, see CURRENT PLAN STATE): spoken while the answer is
 *   recorded; any later model text this turn is dropped.
 */
const RESUME_QUESTION_TOOL = "start_resume_question";
const PLAN_TOOL = "session_plan";

type ToolCall = { kind: string; callId: string; toolName: string; input: unknown };
type ToolResult = { kind?: string; callId?: string; toolName?: string; isError?: boolean; output?: unknown };

/** Mirrors the web app's check in `enqueueWorkspaceCommand` so we never speak a question it will reject. */
export function bridgeableQuestion(action: ToolCall): string | null {
  if (action.kind !== "tool-call" || action.toolName !== RESUME_QUESTION_TOOL) return null;
  const input = action.input as { claimId?: unknown; question?: unknown } | null;
  const question = typeof input?.question === "string" ? input.question.trim() : "";
  const claimId = typeof input?.claimId === "string" ? input.claimId.trim() : "";
  if (!claimId || !question || question.length > 500 || (question.match(/\?/g) ?? []).length !== 1) return null;
  return question;
}

export function bridgeableReply(action: ToolCall): string | null {
  if (action.kind !== "tool-call" || action.toolName !== PLAN_TOOL) return null;
  const reply = (action.input as { reply?: unknown } | null)?.reply;
  const text = typeof reply === "string" ? reply.trim() : "";
  return text && text.length <= 600 ? text : null;
}

function unwrap(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== "object") return {};
  const record = output as Record<string, unknown>;
  const inner = record.value;
  return inner && typeof inner === "object" && !("status" in record) && !("nextAction" in record)
    ? inner as Record<string, unknown>
    : record;
}

export function highlightStatus(result: ToolResult): string | null {
  if (result.kind !== "tool-result" || result.isError) return null;
  const status = unwrap(result.output).status;
  return typeof status === "string" ? status : null;
}

function planNextAction(result: ToolResult): string | null {
  if (result.kind !== "tool-result" || result.isError) return null;
  const kind = (unwrap(result.output).nextAction as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" ? kind : null;
}

/**
 * `usedClaimIds` must persist across the session's requests: a claim that was highlighted (or
 * not found) is spent, and the web app rejects it again — after the bridge would have spoken it.
 */
export function createQuestionBridge(
  mode: "voice" | "chat",
  usedClaimIds: Set<string> = new Set(),
  /** Grades that lead to a follow-up this turn; null = unknown (speak replies as before). */
  followUpGrades: () => string[] | null = () => null,
) {
  const pendingQuestions = new Set<string>();
  const claimByCall = new Map<string, string>();
  let bridgedAtMs: number | null = null;
  let bridgedKind: "question" | "reply" | null = null;
  let resultStatus: string | null = null;
  let planAction: string | null = null;
  let suppressing = false;
  let suppressedChars = 0;
  let heldReplies = 0;

  return {
    /**
     * Returns the text to speak now, or null. The trailing newline matters: LiveKit's markdown
     * filter holds back the last word of a line until a newline or the end of the stream, which
     * would keep the text unspoken until the rest of the turn finishes.
     */
    onToolCalls(actions: ToolCall[]): string | null {
      if (mode !== "voice") return null;
      for (const action of actions) {
        const question = bridgeableQuestion(action);
        if (!question) continue;
        const claimId = String((action.input as { claimId?: unknown }).claimId).trim();
        claimByCall.set(action.callId, claimId);
        // One bridged question per turn, and never one for a claim this session already used.
        if (bridgedKind === "question" || usedClaimIds.has(claimId)) continue;
        pendingQuestions.add(action.callId);
        bridgedAtMs ??= Date.now();
        bridgedKind = "question";
        return `${question}\n`;
      }
      if (bridgedKind) return null;
      for (const action of actions) {
        const reply = bridgeableReply(action);
        if (!reply) continue;
        // A reply graded into a new question is a follow-up the plan won't ask: don't speak it; the
        // model's start_resume_question (bridged) carries what the learner should hear.
        const grade = (action.input as { answerStatus?: unknown } | null)?.answerStatus;
        const allowed = followUpGrades();
        if (allowed && typeof grade === "string" && !allowed.includes(grade)) {
          heldReplies += 1;
          continue;
        }
        bridgedAtMs ??= Date.now();
        bridgedKind = "reply";
        suppressing = true;
        return `${reply}\n`;
      }
      return null;
    },
    onToolResult(result: ToolResult) {
      // session_plan, or start_resume_question when it recorded the answer itself (one-call new question).
      if (result.toolName === PLAN_TOOL || result.toolName === RESUME_QUESTION_TOOL) planAction = planNextAction(result) ?? planAction;
      const status = highlightStatus(result);
      const claimId = result.callId ? claimByCall.get(result.callId) : undefined;
      if (claimId && (status === "highlighted" || status === "not_found")) usedClaimIds.add(claimId);
      if (!result.callId || !pendingQuestions.has(result.callId)) return;
      pendingQuestions.delete(result.callId);
      resultStatus = status ?? (result.isError || result.kind !== "tool-result" ? "error" : "unknown");
      suppressing = resultStatus === "highlighted";
    },
    /** Filters the model's text: null = drop it (a repeat of what was already spoken). */
    onModelText(delta: string): string | null {
      if (suppressing) {
        suppressedChars += delta.length;
        return null;
      }
      return delta;
    },
    trace(startedAtMs: number) {
      // A spoken follow-up while the plan moved on, or a new question while the plan wanted a follow-up.
      const mismatch = planAction !== null && (
        (bridgedKind === "reply" && planAction === "pose_main_question") ||
        (bridgedKind === "question" && planAction !== "pose_main_question")
      );
      return {
        bridged_question: bridgedKind === "question",
        bridged_reply: bridgedKind === "reply",
        bridged_at_ms: bridgedAtMs === null ? null : bridgedAtMs - startedAtMs,
        bridged_result: resultStatus,
        plan_next_action: planAction,
        plan_mismatch: mismatch,
        suppressed_text_chars: suppressedChars,
        held_replies: heldReplies,
      };
    },
  };
}
