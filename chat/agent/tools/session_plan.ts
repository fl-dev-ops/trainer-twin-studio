import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { studioFetch } from "../lib/studio";
import { technicalQuestionTarget } from "../lib/session-plan-config";

export interface RoundPlan {
  id: string;
  name?: string;
  status: "pending" | "active" | "done";
  questionsAsked: number;
  questionsTarget: number;
  followUpsUsed: number;
  followUpsMax: number;
  turnsUsed: number;
}

export interface SessionPlanState {
  currentRound: number;
  rounds: RoundPlan[];
}

const planState = defineState<SessionPlanState>("trainertwin.session_plan", () => ({
  currentRound: 0,
  rounds: [],
}));

const RoundSchema = z.object({
  id: z.string().trim().min(1).describe("Round/stage identifier from AGENT AGENDA in SESSION DATA"),
  name: z.string().trim().optional().describe("Readable name of the round"),
  status: z.enum(["pending", "active", "done"]).default("pending").describe("Status: 'pending', 'active', or 'done'"),
  questionsAsked: z.number().int().min(0).default(0).describe("Main questions asked so far in this round"),
  questionsTarget: z.number().int().min(1).describe("Target main questions for this round"),
  followUpsUsed: z.number().int().min(0).default(0).describe("Follow-ups used on current main question"),
  followUpsMax: z.number().int().min(0).default(1).describe("Max follow-ups allowed per main question"),
  turnsUsed: z.number().int().min(0).default(0).describe("Learner turns in this round"),
});

const SessionPlanInputSchema = z.object({
  action: z.enum(["init", "pose_main_question", "ask_follow_up", "complete_round"]).optional().describe("Shortcut action to advance progress: 'pose_main_question' (increment questionsAsked, reset followUpsUsed), 'ask_follow_up' (increment followUpsUsed), 'complete_round' (mark done and advance to next round)"),
  currentRound: z.number().int().min(0).optional().describe("0-indexed index of active round"),
  rounds: z.array(RoundSchema).optional().describe("Full replacement rounds array. If omitted, tool reads current progress or applies 'action'."),
});

async function autoInitFromStudio(ctx: any): Promise<RoundPlan[]> {
  try {
    const orgId = ctx.session?.auth?.initiator?.principalId ?? ctx.session?.auth?.current?.principalId;
    const attributes = (ctx.session?.auth?.current?.attributes ?? {}) as Record<string, string | undefined>;
    const sessionId = attributes.sessionId;
    const agentSlug = attributes.agentSlug;
    if (!orgId) return [];

    const result = await studioFetch<any>(orgId, {
      action: "getSessionContext",
      sessionId,
      agentSlug,
    });
    const agentData = result.agent?.data ?? {};
    const config = agentData.config ?? {};
    const interview = config.interview ?? {};
    const followUpsMax = typeof interview.follow_ups_per_main_question === "number" ? interview.follow_ups_per_main_question : 1;
    const isResume = interview.type === "resume";

    const rawStages = Array.isArray(agentData.stages) && agentData.stages.length
      ? agentData.stages
      : Array.isArray(agentData.phases) && agentData.phases.length
      ? agentData.phases
      : [{ id: agentData.id ?? agentSlug ?? "interview", name: agentData.name ?? "Interview" }];

    const questionCounts = (interview.question_counts ?? {}) as Record<string, number>;

    return rawStages.map((stage: any, index: number) => {
      const id = typeof stage.id === "string" ? stage.id : typeof stage.name === "string" ? stage.name : `round-${index + 1}`;
      const name = typeof stage.name === "string" ? stage.name : id;
      let target = 1;
      if (isResume) {
        target = typeof interview.main_questions === "number" ? interview.main_questions : 4;
      } else {
        target = technicalQuestionTarget(questionCounts, { id, name }, rawStages.length);
      }

      return {
        id,
        name,
        status: index === 0 ? "active" : "pending",
        questionsAsked: 0,
        questionsTarget: target,
        followUpsUsed: 0,
        followUpsMax,
        turnsUsed: 0,
      } as RoundPlan;
    });
  } catch (e) {
    return [];
  }
}

export default defineTool({
  description: `Track interview rounds, question quotas, follow-ups, and turns across the session.

MUST call on [OPENING] before speaking:
- Call session_plan({}) to auto-initialize your rounds plan from the scenario spec, OR pass { rounds: [...] }.

MUST call during the session as you progress:
- When asking a new main question: session_plan({ action: "pose_main_question" })
- When asking a follow-up: session_plan({ action: "ask_follow_up" })
- When questionsAsked reaches questionsTarget and follow-ups are exhausted: session_plan({ action: "complete_round" })
- When isComplete is true: all quotas are satisfied and minimum turns are met. Deliver closing feedback and ask the candidate to confirm they are ready to end. Do NOT call finish_session on that turn. Call finish_session only on the next turn after they confirm, with no speech.

You can also pass { currentRound, rounds } at any time to directly update the full plan.`,
  inputSchema: SessionPlanInputSchema,
  async execute(input, ctx) {
    let state = planState.get();

    // Auto-init if empty
    if (state.rounds.length === 0 && !Array.isArray(input.rounds)) {
      const autoRounds = await autoInitFromStudio(ctx);
      if (autoRounds.length > 0) {
        planState.update(() => ({ currentRound: 0, rounds: autoRounds }));
        state = planState.get();
      }
    }

    // Direct replacement write
    if (Array.isArray(input.rounds)) {
      const currentRound = typeof input.currentRound === "number" ? input.currentRound : state.currentRound;
      planState.update(() => ({
        currentRound,
        rounds: input.rounds ?? [],
      }));
      state = planState.get();
    }

    // Action shortcuts
    if (input.action && state.rounds.length > 0) {
      planState.update((current) => {
        const rounds = [...current.rounds.map((r) => ({ ...r }))];
        const r = rounds[current.currentRound];
        if (!r) return current;

        if (input.action === "pose_main_question") {
          r.status = "active";
          r.questionsAsked += 1;
          r.followUpsUsed = 0;
          r.turnsUsed += 1;
        } else if (input.action === "ask_follow_up") {
          r.followUpsUsed += 1;
          r.turnsUsed += 1;
        } else if (input.action === "complete_round") {
          r.status = "done";
          const nextIndex = current.currentRound + 1;
          if (nextIndex < rounds.length) {
            rounds[nextIndex].status = "active";
            return { currentRound: nextIndex, rounds };
          }
        }
        return { ...current, rounds };
      });
      state = planState.get();
    }

    const rounds = state.rounds;
    const current = rounds[state.currentRound] ?? null;

    const totalTurnsUsed = rounds.reduce((sum, r) => sum + r.turnsUsed, 0);
    const roundsComplete = rounds.filter((r) => r.status === "done").length;
    const roundsTotal = rounds.length;
    const allQuotasMet = roundsTotal > 0 && roundsComplete === roundsTotal;
    // Minimum turn guard: do not report isComplete until the session has used
    // a reasonable number of turns. Use 4 as an absolute floor (greeting + at
    // least 3 substantive exchanges) to prevent ultra-short sessions.
    const MIN_TURNS_FLOOR = 4;
    const minTurnsRequired = Math.max(MIN_TURNS_FLOOR, rounds.reduce((sum, r) => {
      // If the round has a known minimum from the spec, it will be reflected
      // in turnsUsed naturally; use questionsTarget as a proxy for minimum
      // substantive turns (each main question = at least 1 turn).
      return sum + r.questionsTarget;
    }, 0));
    const minTurnsMet = totalTurnsUsed >= minTurnsRequired;
    const isComplete = allQuotasMet && minTurnsMet;
    const followUpsRemaining = current ? Math.max(0, current.followUpsMax - current.followUpsUsed) : 0;
    const questionsRemainingInRound = current ? Math.max(0, current.questionsTarget - current.questionsAsked) : 0;

    let suggestedAction = "Continue active round: pose main question or follow-up";
    if (roundsTotal === 0) {
      suggestedAction = "Initialize rounds from AGENT AGENDA and INTERVIEW SETTINGS";
    } else if (allQuotasMet && !minTurnsMet) {
      suggestedAction = `Quotas met but only ${totalTurnsUsed} turns used (minimum ${minTurnsRequired}). Continue probing with follow-ups or deeper questions before closing.`;
    } else if (isComplete) {
      suggestedAction = "All rounds completed and minimum turns met. Deliver closing feedback and ask the candidate to confirm ending. Do NOT call finish_session until they confirm on the next turn.";
    } else if (current && questionsRemainingInRound === 0 && followUpsRemaining === 0) {
      suggestedAction = "Round questions and follow-ups complete. Call session_plan({ action: 'complete_round' })";
    } else if (current && current.questionsAsked === 0) {
      suggestedAction = `Pose first main question in round '${current.name ?? current.id}'`;
    }

    return {
      currentRound: state.currentRound,
      currentRoundId: current?.id ?? null,
      currentRoundName: current?.name ?? current?.id ?? null,
      currentRoundStatus: current?.status ?? null,
      questionsAskedInRound: current?.questionsAsked ?? 0,
      questionsTargetInRound: current?.questionsTarget ?? 0,
      questionsRemainingInRound,
      followUpsUsedOnCurrent: current?.followUpsUsed ?? 0,
      followUpsMaxOnCurrent: current?.followUpsMax ?? 0,
      followUpsRemainingOnCurrent: followUpsRemaining,
      totalTurnsUsed,
      minTurnsRequired,
      minTurnsMet,
      summary: {
        totalQuestionsAsked: rounds.reduce((sum, r) => sum + r.questionsAsked, 0),
        totalQuestionsTarget: rounds.reduce((sum, r) => sum + r.questionsTarget, 0),
        roundsComplete,
        roundsTotal,
      },
      isComplete,
      suggestedAction,
      rounds,
    };
  },
});
