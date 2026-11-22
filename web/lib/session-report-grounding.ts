/**
 * Report grounding for a session run by the old interview runtime (its snapshot holds the interview spec): the
 * objective, stages and evidence criteria it was judged on, read straight from the snapshot, plus recorded evidence.
 */
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function formatSessionReportGrounding(snapshot: unknown, evidence: unknown): string {
  const sections: string[] = [];
  const agent = asRecord(asRecord(asRecord(snapshot).agent).data);
  const stages = (Array.isArray(agent.stages) ? agent.stages : Array.isArray(agent.phases) ? agent.phases : []).map(asRecord);
  if (text(agent.objective)) sections.push(`Scenario objective: ${text(agent.objective)}`);
  const phases = stages.map((stage) => `- ${text(stage.name) || text(stage.id)}: ${text(stage.objective)}`).filter((line) => line !== "- : ");
  if (phases.length) sections.push(`Scenario phases:\n${phases.join("\n")}`);
  const criteria = stages.flatMap((stage) => {
    const definitions = asRecord(asRecord(asRecord(stage.config).evidence).definitions);
    return Object.entries(definitions).filter(([, value]) => text(value)).map(([key, value]) => `- ${key}: ${text(value)}`);
  });
  if (criteria.length) sections.push(`Evaluation criteria:\n${criteria.join("\n")}`);
  if (evidence && typeof evidence === "object") {
    sections.push(`Recorded session evidence:\n${JSON.stringify(evidence, null, 2)}`);
  }
  return sections.join("\n\n");
}
