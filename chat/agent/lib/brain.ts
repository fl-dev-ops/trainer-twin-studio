import { studioFetch } from "./studio";

/**
 * Loads the scenario + persona specs and attached documents from the TrainerTwin
 * studio and formats the per-session grounding block.
 */

type SpecRow = { slug: string; version: number; data: Record<string, unknown> };

export type AttachedDocument = {
  id: string;
  name: string;
  kind: string;
  mimeType?: string;
  size?: number;
  pageCount?: number;
};

export type SessionSpecs = {
  sessionId?: string;
  agentName: string;
  agentSlug: string;
  objective: string;
  phases: { name?: string; objective: string }[];
  opening?: string;
  personaName?: string;
  personaSlug?: string;
  personaVoice?: string;
  documents: AttachedDocument[];
  learnerName?: string | null;
  mode?: "voice" | "chat";
};

export async function loadSessionContext(
  orgId: string,
  sessionId?: string,
  agentSlug?: string,
  personaSlug?: string,
  mode: "voice" | "chat" = "voice",
): Promise<SessionSpecs> {
  const result = await studioFetch<{
    sessionId: string | null;
    agent: SpecRow | null;
    persona: SpecRow | null;
    documents: AttachedDocument[];
    learnerName?: string | null;
  }>(orgId, {
    action: "getSessionContext",
    sessionId,
    agentSlug,
    personaSlug,
  });

  const agentData = (result.agent?.data ?? {}) as {
    name?: string;
    objective?: string;
    opening?: string;
    domain?: string;
    phases?: { name?: string; objective?: string }[];
    stages?: { name?: string; objective?: string }[];
  };

  const phases = (agentData.phases ?? agentData.stages ?? [])
    .map((phase) => ({ name: phase.name, objective: phase.objective ?? "" }))
    .filter((phase) => phase.objective);

  const personaData = (result.persona?.data ?? {}) as {
    name?: string;
    decision_preferences?: unknown;
    style?: unknown;
  };

  let personaVoice: string | undefined;
  if (personaData.decision_preferences) {
    personaVoice = JSON.stringify(personaData.decision_preferences).slice(0, 2000);
  }

  return {
    sessionId: result.sessionId ?? sessionId,
    agentName: agentData.name ?? result.agent?.slug ?? agentSlug ?? "Interview",
    agentSlug: result.agent?.slug ?? agentSlug ?? "interview",
    objective: agentData.objective ?? "",
    phases,
    opening: typeof agentData.opening === "string" ? agentData.opening : undefined,
    personaName: personaData.name ?? result.persona?.slug ?? personaSlug,
    personaSlug: result.persona?.slug ?? personaSlug,
    personaVoice,
    documents: result.documents ?? [],
    learnerName: result.learnerName,
    mode,
  };
}

export function formatSessionSpec(specs: SessionSpecs): string {
  const phases = specs.phases.length > 0
    ? specs.phases.map((phase, index) => `${index + 1}. ${phase.name ? `${phase.name}: ` : ""}${phase.objective}`).join("\n")
    : `1. ${specs.objective}`;

  const docsBlock = specs.documents.length > 0
    ? specs.documents
        .map((d) => `- [${d.kind.toUpperCase()}] id: "${d.id}", name: "${d.name}"${d.pageCount ? ` (${d.pageCount} pages)` : ""}`)
        .join("\n") +
      "\nSHOW-AND-TELL ARTIFACT RULE: At session start (or when discussing this document), call surface with action 'open_pdf' and payload { fileId: '<doc_id>' } while speaking. Open it directly without asking permission."
    : "None attached. Do not claim documents are available on screen.";

  return `SESSION SPEC
Scenario: ${specs.agentName} (slug: ${specs.agentSlug})
Objective: ${specs.objective}
${specs.opening ? `Opening brief: ${specs.opening}` : ""}

INTERVIEW PROGRESSION (guidance, not a script — bridge topics naturally):
${phases}

PERSONA: ${specs.personaName ?? specs.personaSlug ?? "Trainer"} (slug: ${specs.personaSlug ?? "trainer"})
${specs.personaVoice ? `How this trainer behaves and decides (from their indexed records): ${specs.personaVoice}` : ""}

ATTACHED ARTIFACTS FOR SHOW-AND-TELL:
${docsBlock}

OPERATING MODE: ${specs.mode === "voice" ? "VOICE CALL (Spoken-first, audio formatting strictly enforced, under 50 words)" : "TEXT CHAT (Interactive text conversation)"}`;
}
