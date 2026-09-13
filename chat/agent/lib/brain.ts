import { studioFetch } from "./studio";

/**
 * Loads the scenario + persona specs from the TrainerTwin studio and formats
 * the per-session grounding block. Persona-agnostic: everything comes from the
 * trainer's own indexed specs, nothing is hardcoded to one trainer.
 */

type SpecRow = { slug: string; version: number; data: Record<string, unknown> };

export type SessionSpecs = {
  agentName: string;
  objective: string;
  phases: { name?: string; objective: string }[];
  opening?: string;
  personaName?: string;
  personaVoice?: string;
};

export async function loadSessionSpecs(orgId: string, agentSlug: string, personaSlug?: string): Promise<SessionSpecs> {
  const agent = await studioFetch<SpecRow>(orgId, { action: "readSpec", type: "agent", slug: agentSlug });
  const data = agent.data as {
    name?: string;
    objective?: string;
    opening?: string;
    domain?: string;
    phases?: { name?: string; objective?: string }[];
    stages?: { name?: string; objective?: string }[];
    required_evidence?: Record<string, unknown>;
  };

  const phases = (data.phases ?? data.stages ?? [])
    .map((phase) => ({ name: phase.name, objective: phase.objective ?? "" }))
    .filter((phase) => phase.objective);

  const specs: SessionSpecs = {
    agentName: data.name ?? agentSlug,
    objective: data.objective ?? "",
    phases,
    opening: typeof data.opening === "string" ? data.opening : undefined,
  };

  if (personaSlug) {
    const persona = await studioFetch<SpecRow>(orgId, { action: "readSpec", type: "persona", slug: personaSlug });
    const personaData = persona.data as { name?: string; decision_preferences?: unknown; style?: unknown };
    specs.personaName = typeof personaData.name === "string" ? personaData.name : undefined;
    if (personaData.decision_preferences) {
      specs.personaVoice = JSON.stringify(personaData.decision_preferences).slice(0, 2000);
    }
  }

  return specs;
}

export function formatSessionSpec(specs: SessionSpecs, agentSlug: string): string {
  const phases = specs.phases.length > 0
    ? specs.phases.map((phase, index) => `${index + 1}. ${phase.name ? `${phase.name}: ` : ""}${phase.objective}`).join("\n")
    : `1. ${specs.objective}`;

  return `SESSION SPEC
Scenario: ${specs.agentName}
Objective: ${specs.objective}
${specs.opening ? `Opening brief: ${specs.opening}` : ""}

INTERVIEW PROGRESSION (guidance, not a script — a real trainer bridges topics naturally):
${phases}

PERSONA: ${specs.personaName ?? agentSlug}
${specs.personaVoice ? `How this trainer behaves and decides (from their own records): ${specs.personaVoice}` : ""}`;
}
