import { buildSpecs } from "@/lib/runtime/compiler";

export function formatSessionReportGrounding(snapshot: unknown, evidence: unknown): string {
  const sections: string[] = [];

  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    try {
      const { agent } = buildSpecs(snapshot as Record<string, unknown>);
      const criteria = Object.entries(agent.required_evidence)
        .map(([key, description]) => `- ${key}: ${description}`)
        .join("\n");
      const phases = agent.phases
        .map((phase) => `- ${phase.name}: ${phase.objective}`)
        .join("\n");

      sections.push(`Scenario objective: ${agent.objective}`);
      if (phases) sections.push(`Scenario phases:\n${phases}`);
      if (criteria) sections.push(`Evaluation criteria:\n${criteria}`);
    } catch {
      // Older sessions may not contain a compilable snapshot.
    }
  }

  if (evidence && typeof evidence === "object") {
    sections.push(`Recorded session evidence:\n${JSON.stringify(evidence, null, 2)}`);
  }

  return sections.join("\n\n");
}
