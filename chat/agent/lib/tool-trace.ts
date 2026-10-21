/**
 * Compact, privacy-safe view of what the model sent to a tool and what came back, for
 * [brain-trace]. Keeps decision fields (actions, statuses, next steps) and drops free text
 * such as resume claim text, answers, questions, queries, and error messages.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Tool outputs may arrive plain or wrapped as { type, value }. */
function object(value: unknown): Json {
  if (!isObject(value)) return {};
  const isWrapper = isObject(value.value) && Object.keys(value).every((key) => key === "value" || key === "type");
  return isWrapper ? value.value as Json : value;
}

export function summarizeToolInput(toolName: string, input: unknown): Json {
  const data = object(input);
  if (toolName === "session_plan") {
    return {
      action: data.action ?? null,
      answerStatus: data.answerStatus ?? null,
      evidenceUpdates: data.evidenceUpdates ? Object.keys(data.evidenceUpdates as Json) : [],
    };
  }
  if (toolName === "start_resume_question") {
    return {
      claimId: data.claimId ?? null,
      answerStatus: data.answerStatus ?? null,
      evidenceUpdates: data.evidenceUpdates ? Object.keys(data.evidenceUpdates as Json) : [],
    };
  }
  if (toolName === "get_resume_claim") return { claimId: data.claimId ?? null };
  if (toolName === "surface") return { action: data.action ?? null };
  return Object.fromEntries(Object.keys(data).map((key) => [key, typeof data[key]]));
}

export function summarizeToolOutput(toolName: string, output: unknown, isError?: boolean): Json {
  if (isError) return { error: true };
  const data = object(output);
  if (toolName === "session_plan") {
    const active = object(data.activeQuestion);
    const candidates = Array.isArray(data.resumeClaimCandidates) ? data.resumeClaimCandidates : [];
    return {
      nextAction: object(data.nextAction).kind ?? null,
      nextQuestionType: object(data.nextAction).questionType ?? null,
      activeQuestionId: active.id ?? null,
      followUpsRemaining: active.followUpsRemaining ?? null,
      totalTurnsUsed: data.totalTurnsUsed ?? null,
      resumeClaimCandidates: candidates.map((claim) => object(claim).claimId),
      ...(data.alreadyRecordedThisTurn ? { alreadyRecordedThisTurn: true } : {}),
    };
  }
  if ("status" in data) {
    return {
      status: data.status,
      ...(data.nextAction ? { nextAction: object(data.nextAction).kind ?? null } : {}),
      ...(data.planMismatch ? { planMismatch: true, planCorrected: Boolean(data.planCorrected) } : {}),
      ...(data.alreadyRecordedThisTurn ? { alreadyRecordedThisTurn: true } : {}),
    };
  }
  if ("error" in data) return { error: true };
  return {};
}
