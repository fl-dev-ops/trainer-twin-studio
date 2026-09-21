export function technicalQuestionTarget(
  questionCounts: Record<string, number>,
  stage: { id: string; name?: string },
  stageCount: number,
) {
  const configured = Object.entries(questionCounts).filter(([, count]) => Number.isFinite(count) && count > 0);
  if (stageCount === 1) return configured.reduce((sum, [, count]) => sum + count, 0) || 1;

  const label = `${stage.id} ${stage.name ?? ""}`.toLowerCase();
  return configured.find(([kind]) => label.includes(kind))?.[1] ?? 1;
}
