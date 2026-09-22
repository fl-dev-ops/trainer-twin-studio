import { defineState } from "eve/context";

export type ActiveMcq = {
  questionId: string;
  correctOptionId: string;
};

export const activeMcqState = defineState<ActiveMcq | null>("trainertwin.active_mcq", () => null);

export function prepareMcqPayload(payload: Record<string, unknown>) {
  const questionId = typeof payload.questionId === "string" ? payload.questionId.trim() : "";
  const correctOptionId = typeof payload.correctOptionId === "string" ? payload.correctOptionId.trim() : "";
  const options = Array.isArray(payload.options) ? payload.options : [];
  if (!questionId || !correctOptionId || !options.some((option) =>
    option && typeof option === "object" && "id" in option && option.id === correctOptionId)) {
    throw new Error("open_choice requires questionId and a correctOptionId matching one option");
  }
  const { correctOptionId: _privateAnswer, ...publicPayload } = payload;
  return { active: { questionId, correctOptionId }, publicPayload };
}

export function gradeMcqSelection(active: ActiveMcq | null, questionId: unknown, selectedId: unknown) {
  if (!active || questionId !== active.questionId || typeof selectedId !== "string") return null;
  return selectedId === active.correctOptionId;
}
