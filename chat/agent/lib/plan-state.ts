import { defineState } from "eve/context";
import type { ProjectKnowledge } from "./project-knowledge";
import type { ResumeClaimCandidate } from "./resume-candidates";
import type { StyleCache } from "./style-cache";
import type { SessionPlanState } from "./session-plan";

/** Interview plan, shared by the session_plan tool and the per-turn plan block. */
export const planState = defineState<SessionPlanState | null>("trainertwin.session_plan", () => null);

/**
 * Resume claims prefetched by session_plan for the next main question, minus claims that
 * start_resume_question has since used. Read at turn start so the model can pose a new
 * question in the same call that records the answer.
 */
export const resumeCandidateState = defineState<{ candidates: ResumeClaimCandidate[]; usedClaimIds: string[] }>(
  "trainertwin.resume_candidates",
  () => ({ candidates: [], usedClaimIds: [] }),
);

/** Trainer phrasing per recurring moment, fetched once per session off the critical path. */
export const styleCacheState = defineState<{ cache: StyleCache | null }>("trainertwin.style_cache", () => ({ cache: null }));

/** Knowledge snippets for the resume project currently being discussed (replaced per new question). */
export const projectKnowledgeState = defineState<{ current: ProjectKnowledge | null }>("trainertwin.project_knowledge", () => ({ current: null }));
