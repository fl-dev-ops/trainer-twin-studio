export const QUESTION_TYPES = ["verbal", "mcq", "coding", "code-output", "machine-coding", "system-design"] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number] | "resume";
export type EvidenceStatus = "untested" | "partial" | "sufficient" | "weak" | "unresolved";
export type AnswerStatus = "strong" | "partial" | "vague" | "contradictory" | "unknown";
export type ClosingState = "interviewing" | "awaiting_confirmation" | "confirmed";

export interface PlanQuestion {
  id: string;
  type: QuestionType;
  status: "pending" | "active" | "done";
  followUpsUsed: number;
  followUpsMax: number;
}

export interface PlanRound {
  id: string;
  name: string;
  status: "pending" | "active" | "done";
  minimumTurns: number;
  maximumTurns: number;
  turnsUsed: number;
  questions: PlanQuestion[];
  evidence: Record<string, EvidenceStatus>;
  completionKeys: string[];
}

export interface SessionPlanState {
  currentRound: number;
  sessionMaximumTurns: number;
  closingState: ClosingState;
  rounds: PlanRound[];
}

type AgentData = {
  id?: string;
  name?: string;
  config?: {
    interview?: {
      type?: "resume" | "technical";
      main_questions?: number;
      question_counts?: Partial<Record<(typeof QUESTION_TYPES)[number], number>>;
      follow_ups_per_main_question?: number;
    };
    turns?: { maximum?: number };
  };
  stages?: Array<{
    id?: string;
    name?: string;
    config?: {
      turns?: { minimum?: number; maximum?: number };
      evidence?: { keys?: string[]; completion_keys?: string[] };
    };
  }>;
  phases?: AgentData["stages"];
};

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function configuredQuestionTypes(interview: NonNullable<AgentData["config"]>["interview"]): QuestionType[] {
  if (interview?.type === "resume") {
    return Array.from({ length: positiveInteger(interview.main_questions, 4) }, () => "resume");
  }

  return QUESTION_TYPES.flatMap((type) =>
    Array.from({ length: positiveInteger(interview?.question_counts?.[type], 0) }, () => type),
  );
}

function questionsForStage(
  stageId: string,
  stageIndex: number,
  stageCount: number,
  configuredTypes: QuestionType[],
  followUpsMax: number,
) {
  const typeCounts = new Map<QuestionType, number>();
  return configuredTypes.flatMap((type, index) => {
    if (index % stageCount !== stageIndex) return [];
    const typeIndex = (typeCounts.get(type) ?? 0) + 1;
    typeCounts.set(type, typeIndex);
    return [{
      id: `${stageId}:${type}:${typeIndex}`,
      type,
      status: "pending",
      followUpsUsed: 0,
      followUpsMax,
    } satisfies PlanQuestion];
  });
}

export function compileSessionPlan(agentData: AgentData): SessionPlanState {
  const interview = agentData.config?.interview;
  const followUpsMax = Math.max(0, positiveInteger(interview?.follow_ups_per_main_question, 0));
  const stages = agentData.stages?.length ? agentData.stages : agentData.phases?.length
    ? agentData.phases
    : [{ id: agentData.id ?? "interview", name: agentData.name ?? "Interview", config: {} }];
  const configuredTypes = configuredQuestionTypes(interview);

  const rounds = stages.map((stage, index): PlanRound => {
    const id = stage.id ?? `round-${index + 1}`;
    const evidenceKeys = stage.config?.evidence?.keys ?? [];
    return {
      id,
      name: stage.name ?? id,
      status: index === 0 ? "active" : "pending",
      minimumTurns: Math.max(0, stage.config?.turns?.minimum ?? 0),
      maximumTurns: positiveInteger(stage.config?.turns?.maximum, positiveInteger(agentData.config?.turns?.maximum, 12)),
      turnsUsed: 0,
      questions: questionsForStage(id, index, stages.length, configuredTypes, followUpsMax),
      evidence: Object.fromEntries([...new Set([...evidenceKeys, ...(stage.config?.evidence?.completion_keys ?? [])])]
        .map((key) => [key, "untested"])),
      completionKeys: stage.config?.evidence?.completion_keys ?? [],
    };
  });

  return {
    currentRound: 0,
    sessionMaximumTurns: positiveInteger(agentData.config?.turns?.maximum, 12),
    closingState: "interviewing",
    rounds,
  };
}

function totalTurns(state: SessionPlanState) {
  return state.rounds.reduce((sum, round) => sum + round.turnsUsed, 0);
}

function completionSatisfied(round: PlanRound) {
  return round.completionKeys.every((key) => round.evidence[key] === "sufficient");
}

function activateNextQuestion(state: SessionPlanState, round: PlanRound) {
  const current = activeQuestion(round);
  if (current) return current;
  if (round.turnsUsed >= round.maximumTurns || totalTurns(state) >= state.sessionMaximumTurns) return null;
  const question = round.questions.find(({ status }) => status === "pending");
  if (!question) return null;
  question.status = "active";
  round.turnsUsed += 1;
  return question;
}

function activeQuestion(round: PlanRound) {
  return round.questions.find(({ status }) => status === "active") ?? null;
}

function nextAction(state: SessionPlanState) {
  const round = state.rounds[state.currentRound] ?? null;
  if (state.closingState === "confirmed") return { kind: "finish_session" as const };
  if (state.closingState === "awaiting_confirmation") return { kind: "await_confirmation" as const };
  if (!round) return { kind: "start_closing" as const, reason: "no_rounds" };

  const active = activeQuestion(round);
  if (active) return active.followUpsUsed > 0
    ? { kind: "ask_follow_up" as const, questionId: active.id, questionType: active.type }
    : { kind: "pose_main_question" as const, questionId: active.id, questionType: active.type };

  const pending = round.questions.find(({ status }) => status === "pending");
  if (pending) return { kind: "prepare_next" as const, questionId: pending.id, questionType: pending.type };

  const budgetExhausted = round.turnsUsed >= round.maximumTurns || totalTurns(state) >= state.sessionMaximumTurns;
  if ((completionSatisfied(round) && round.turnsUsed >= round.minimumTurns) || budgetExhausted) {
    return { kind: "start_closing" as const, reason: budgetExhausted ? "turn_budget_exhausted" : "complete" };
  }

  return { kind: "start_closing" as const, reason: "question_budget_exhausted" };
}

function activateEvidenceFollowUp(state: SessionPlanState, round: PlanRound) {
  if (
    completionSatisfied(round) && round.turnsUsed >= round.minimumTurns ||
    round.turnsUsed >= round.maximumTurns ||
    totalTurns(state) >= state.sessionMaximumTurns
  ) return null;

  const question = [...round.questions].reverse().find((item) => item.followUpsUsed < item.followUpsMax);
  if (!question) return null;
  question.status = "active";
  question.followUpsUsed += 1;
  round.turnsUsed += 1;
  return question;
}

export type PlanEvent =
  | { type: "prepare_next" }
  | { type: "record_answer"; answerStatus: AnswerStatus; evidenceUpdates?: Record<string, EvidenceStatus> }
  | { type: "start_closing" }
  | { type: "learner_question_during_closing" }
  | { type: "confirm_end" };

export function advanceSessionPlan(state: SessionPlanState, event: PlanEvent) {
  const round = state.rounds[state.currentRound] ?? null;

  if (event.type === "start_closing") {
    if (nextAction(state).kind !== "start_closing") throw new Error("Session is not ready to close");
    state.closingState = "awaiting_confirmation";
  } else if (event.type === "learner_question_during_closing") {
    if (state.closingState !== "awaiting_confirmation") throw new Error("Session is not awaiting confirmation");
  } else if (event.type === "confirm_end") {
    if (state.closingState !== "awaiting_confirmation") throw new Error("Session is not awaiting confirmation");
    state.closingState = "confirmed";
  } else if (event.type === "prepare_next") {
    if (state.closingState !== "interviewing" || !round) throw new Error("Cannot prepare an interview question now");
    activateNextQuestion(state, round);
  } else if (event.type === "record_answer") {
    if (state.closingState !== "interviewing" || !round) throw new Error("Cannot record an interview answer now");
    for (const [key, status] of Object.entries(event.evidenceUpdates ?? {})) {
      if (!(key in round.evidence)) throw new Error(`Unknown evidence key: ${key}`);
      round.evidence[key] = status === "sufficient" && event.answerStatus !== "strong" ? "partial" : status;
    }

    const active = activeQuestion(round);
    if (!active) {
      activateNextQuestion(state, round);
    } else if (event.answerStatus === "strong") {
      active.status = "done";
      if (!activateNextQuestion(state, round)) activateEvidenceFollowUp(state, round);
    } else if (
      active.followUpsUsed < active.followUpsMax &&
      round.turnsUsed < round.maximumTurns &&
      totalTurns(state) < state.sessionMaximumTurns
    ) {
      active.followUpsUsed += 1;
      round.turnsUsed += 1;
    } else {
      active.status = "done";
      if (!activateNextQuestion(state, round)) activateEvidenceFollowUp(state, round);
    }
  }

  let action = nextAction(state);
  if (round && action.kind === "start_closing") {
    round.status = "done";
    const nextRound = state.rounds[state.currentRound + 1];
    if (nextRound) {
      state.currentRound += 1;
      nextRound.status = "active";
      action = nextAction(state);
    }
  }
  return { state, nextAction: action };
}

export function summarizeSessionPlan(state: SessionPlanState) {
  const round = state.rounds[state.currentRound] ?? null;
  const action = nextAction(state);
  return {
    currentRound: state.currentRound,
    currentRoundId: round?.id ?? null,
    currentRoundName: round?.name ?? null,
    closingState: state.closingState,
    totalTurnsUsed: totalTurns(state),
    sessionMaximumTurns: state.sessionMaximumTurns,
    evidence: round?.evidence ?? {},
    missingCompletionKeys: round?.completionKeys.filter((key) => round.evidence[key] !== "sufficient") ?? [],
    questions: round?.questions ?? [],
    nextAction: action,
    isComplete: action.kind === "start_closing" || state.closingState !== "interviewing",
  };
}
