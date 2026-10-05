import { defineState } from "eve/context";

type KnowledgeGrounding = {
  turnId: string;
  relevant: boolean;
};

export const knowledgeGroundingState = defineState<KnowledgeGrounding | null>(
  "trainertwin.knowledge_grounding",
  () => null,
);

export function hasRelevantKnowledgeGrounding(turnId: string) {
  const grounding = knowledgeGroundingState.get();
  return grounding?.turnId === turnId && grounding.relevant;
}
