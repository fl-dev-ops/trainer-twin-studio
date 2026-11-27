import { defineState } from "eve/context";

export type ActiveMcq = {
  questionId: string;
  correctOptionId: string;
};

export const activeMcqState = defineState<ActiveMcq | null>("trainertwin.active_mcq", () => null);

/** A question that points at code it expects on screen ("the code shown above", "what does this snippet log"). */
const REFERS_TO_CODE = /\b(?:code|snippet|program|function)\b[^.?!]*\b(?:above|below|shown|following|given)\b|\b(?:above|below|shown|following|given|this|the)\s+(?:code|snippet|program)\b|\bwhat\s+(?:is|gets)\s+(?:logged|printed)\b/i;

/**
 * The code block shown with the question: payload.code as { language, content }, or as a plain string (with an
 * optional payload.language). Anything else is no code.
 */
export function mcqCode(payload: Record<string, unknown>): { language: string; content: string } | undefined {
  const raw = payload.code;
  const language = typeof payload.language === "string" && payload.language.trim() ? payload.language.trim() : "javascript";
  if (typeof raw === "string") return raw.trim() ? { language, content: raw } : undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const code = raw as Record<string, unknown>;
    const content = typeof code.content === "string" ? code.content : typeof code.code === "string" ? code.code : "";
    if (!content.trim()) return undefined;
    return { language: typeof code.language === "string" && code.language.trim() ? code.language.trim() : language, content };
  }
  return undefined;
}

export function prepareMcqPayload(payload: Record<string, unknown>) {
  const questionId = typeof payload.questionId === "string" ? payload.questionId.trim() : "";
  const correctOptionId = typeof payload.correctOptionId === "string" ? payload.correctOptionId.trim() : "";
  const options = Array.isArray(payload.options) ? payload.options : [];
  if (!questionId || !correctOptionId || !options.some((option) =>
    option && typeof option === "object" && "id" in option && option.id === correctOptionId)) {
    throw new Error("open_choice requires questionId and a correctOptionId matching one option");
  }
  const code = mcqCode(payload);
  const question = typeof payload.question === "string" ? payload.question : "";
  // The learner sees only what the payload carries: a question about code with no code is unanswerable.
  if (!code && REFERS_TO_CODE.test(question)) {
    throw new Error("open_choice: the question refers to code, but payload.code is empty. Call it again with the full snippet in payload.code as { language, content }.");
  }
  const { correctOptionId: _privateAnswer, language: _language, ...rest } = payload;
  const publicPayload = code ? { ...rest, code } : rest;
  return { active: { questionId, correctOptionId }, publicPayload };
}

export function gradeMcqSelection(active: ActiveMcq | null, questionId: unknown, selectedId: unknown) {
  if (!active || questionId !== active.questionId || typeof selectedId !== "string") return null;
  return selectedId === active.correctOptionId;
}
