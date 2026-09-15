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
  summary?: string;
  headings?: string[];
};

export type ResumeClaim = {
  id: string;
  claimNo: number;
  section: string;
  kind: string;
  text: string;
  anchor: string;
  metric: string | null;
  page: number | null;
};

export type SessionSpecs = {
  sessionId?: string;
  agentName: string;
  agentSlug: string;
  objective: string;
  phases: { name?: string; objective: string; knowledge_tags?: string[] }[];
  opening?: string;
  personaName?: string;
  personaSlug?: string;
  personaVoice?: string;
  documents: AttachedDocument[];
  resume?: {
    documentId: string;
    extractedText: string;
    claims: ResumeClaim[];
  } | null;
  learnerName?: string | null;
  learnerHistory?: {
    isReturning: boolean;
    pastSessionCount: number;
    lastSessionDate?: string | null;
  };
  uiState?: {
    active: string | null;
    key?: string | null;
    updatedAt?: string;
  } | null;
  mode?: "voice" | "chat";
  knowledgeBases?: string[];
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
    resume?: {
      documentId: string;
      extractedText: string;
      claims: ResumeClaim[];
    } | null;
    learnerName?: string | null;
    learnerHistory?: {
      isReturning: boolean;
      pastSessionCount: number;
      lastSessionDate?: string | null;
    };
    uiState?: {
      active: string | null;
      key?: string | null;
      updatedAt?: string;
    } | null;
    knowledgeBases?: string[];
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
    .map((phase: any) => ({
      name: phase.name,
      objective: phase.objective ?? "",
      knowledge_tags: Array.isArray(phase.knowledge_tags)
        ? phase.knowledge_tags
        : Array.isArray(phase.tags)
          ? phase.tags
          : undefined,
    }))
    .filter((phase: any) => phase.objective);

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
    resume: result.resume ?? null,
    learnerName: result.learnerName,
    learnerHistory: result.learnerHistory,
    uiState: result.uiState ?? null,
    knowledgeBases: Array.isArray(result.knowledgeBases) ? result.knowledgeBases : [],
    mode,
  };
}

export function formatSessionSpec(specs: SessionSpecs): string {
  const phases = specs.phases.length > 0
    ? specs.phases.map((phase, index) => {
        const topics = phase.knowledge_tags && phase.knowledge_tags.length > 0
          ? ` [Approved Knowledge Topics: ${phase.knowledge_tags.join(", ")}]`
          : "";
        return `${index + 1}. ${phase.name ? `${phase.name}: ` : ""}${phase.objective}${topics}`;
      }).join("\n")
    : `1. ${specs.objective}`;

  const docsBlock = specs.documents.length > 0
    ? specs.documents
        .map((d) => {
          const sections = d.headings && d.headings.length > 0 ? ` [Sections: ${d.headings.join(", ")}]` : "";
          return `- [${d.kind.toUpperCase()}] id: "${d.id}", name: "${d.name}"${d.pageCount ? ` (${d.pageCount} pages)` : ""}${sections}`;
        })
        .join("\n") +
      "\nArtifact Guidance: Open an attached document via `surface({ action: 'open_pdf', payload: { fileId: '<doc_id>' } })` when actively discussing or reviewing it. Call `read_document(documentId, query)` when specific unverified dates, metrics, or details are needed."
    : "None attached. Do not claim documents are available on screen.";

  let resumeBlock = "";
  if (specs.resume) {
    const claims = specs.resume.claims ?? [];
    const claimList = claims.length > 0
      ? claims.slice(0, 30).map((c) => `- [${c.kind.toUpperCase()}] "${c.text}" (section: ${c.section}, anchor: "${c.anchor}"${c.metric ? `, metric: "${c.metric}"` : ""})`).join("\n")
      : "No structured claims extracted.";

    resumeBlock = `\nTHE CANDIDATE'S RESUME (verbatim reference text):
${specs.resume.extractedText.slice(0, 3500)}

RESUME CLAIM QUEUE & HIGHLIGHTING RULES:
1. One claim at a time — but only AFTER the candidate has given a broad picture of their background (Turn 2's open question has been answered). Until then, keep opening questions broad; do not drill into a specific claim yet.
2. When drilling in: select an un-questioned claim from the queue below for your main question.
3. For impact or quantification rounds, prioritize claims with metrics.
4. Show-and-Tell Highlight: when asking about a claim, call surface with action 'open_pdf' and payload { fileId: '${specs.resume.documentId}', highlightQuery: '<anchor>' } so the candidate's PDF viewer highlights the exact line while you speak.
5. Drill into their specific technical contribution, mechanism, challenges, and ownership before moving to another claim. Never re-ask an already answered claim.

CLAIMS AVAILABLE TO PROBE:
${claimList}\n`;
  }

  const uiStateBlock = specs.uiState
    ? (() => {
        const label = (active: string | null) =>
          active === "code" ? "Code editor"
          : active === "canvas" ? "Whiteboard"
          : active === "pdf" ? "PDF document viewer"
          : active === "image" ? "Image viewer"
          : active === "presentation" ? "Presentation"
          : null;
        const current = label(specs.uiState?.active ?? null);
        return `CURRENT SCREEN STATE (ground truth of what the candidate sees, reported by their browser${specs.uiState?.updatedAt ? ` as of ${specs.uiState.updatedAt}` : ""}):
- Active workspace panel: ${current ?? "NONE — no workspace panel is open"}
SCREEN-STATE RULES:
1. Trust this report over your assumptions. If it says NONE, no editor, whiteboard, or document is visible — never reference one as if the candidate can see it.
2. If a panel you opened earlier was closed by the candidate, acknowledge it naturally if relevant ("I see you closed the whiteboard") instead of continuing to talk about it as if open.
3. To show something again, re-open it with the appropriate surface call — do not assume it is still visible.`;
      })()
    : "";

  const nameLine = specs.learnerName ? `- Name: ${specs.learnerName} (use naturally, not every turn)` : "- Name: not yet known — use the candidate's name only if they state it in speech";

  const icebreakerBlock = specs.learnerHistory?.isReturning
    ? `LEARNER CONTEXT (RETURNING CANDIDATE):
${nameLine}
- Status: Returning candidate (last session: ${specs.learnerHistory.lastSessionDate ? new Date(specs.learnerHistory.lastSessionDate).toLocaleDateString() : "earlier"}).
- Never state session counts or numbers; acknowledge familiarity naturally ("good to see you again").
- Turn 1: Warm welcome + one simple check-in question. Stop and let the candidate speak.
- Turn 2: Respond warmly, frame the session, and open relevant workspace surfaces (PDF, whiteboard, editor) only when actively transitioning to that topic.`
    : `LEARNER CONTEXT (FIRST-TIME CANDIDATE):
${nameLine}
- Status: First-time candidate.
- Turn 1: Warm welcome + one simple check-in question. Stop and let the candidate speak.
- Turn 2: Respond warmly, normalize any nerves, frame the session, and open relevant workspace surfaces only when actively transitioning to that topic.`;

  const knowledgeBlock = (specs.knowledgeBases ?? []).length > 0
    ? `KNOWLEDGE BASES (approved grounding sources):
${(specs.knowledgeBases ?? []).map((kb) => `- "${kb}"`).join("\n")}
When a substantive domain claim needs verification against this trainer's approved materials, call search_knowledge(knowledgeBase: "${(specs.knowledgeBases ?? [])[0]}", query: <standalone concept keywords>, topics: <active phase topics>). If no relevant reference is found, acknowledge calibrated uncertainty — never invent or attribute a trainer-owned fact.`
    : "";

  return `SESSION SPEC
Scenario: ${specs.agentName} (slug: ${specs.agentSlug})
Objective: ${specs.objective}
${specs.opening ? `Opening brief: ${specs.opening}` : ""}

${icebreakerBlock}

INTERVIEW PROGRESSION (guidance, not a script — bridge topics naturally):
${phases}
${knowledgeBlock ? `\n${knowledgeBlock}` : ""}

PERSONA: ${specs.personaName ?? specs.personaSlug ?? "Trainer"} (slug: ${specs.personaSlug ?? "trainer"})
${specs.personaVoice ? `How this trainer behaves and decides (from their indexed records): ${specs.personaVoice}` : ""}
${uiStateBlock ? `\n${uiStateBlock}` : ""}

ATTACHED ARTIFACTS FOR SHOW-AND-TELL & INSPECTION:
${docsBlock}
${resumeBlock}
OPERATING MODE: ${specs.mode === "voice" ? "VOICE CALL (Spoken-first, audio formatting strictly enforced, under 50 words)" : "TEXT CHAT (Interactive text conversation)"}`;
}
