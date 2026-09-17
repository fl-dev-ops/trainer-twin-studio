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
  knowledgeBases: { slug: string; name: string }[];
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
    knowledgeBases: { slug: string; name: string }[];
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
    knowledgeBases: result.knowledgeBases ?? [],
    documents: result.documents ?? [],
    resume: result.resume ?? null,
    learnerName: result.learnerName,
    learnerHistory: result.learnerHistory,
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
      "\nDOCUMENT ACCESS RULE: Call the `read_document(documentId, query)` tool whenever the candidate refers to a past company, timeframe, or system from their resume that you need exact details on. Do not guess dates or company details.\nSHOW-AND-TELL ARTIFACT RULE: At session start (or when discussing a document), call surface with action 'open_pdf' and payload { fileId: '<doc_id>' } while speaking. If conducting system design, call surface with action 'open_whiteboard' or use 'highlight_whiteboard'. Open it directly without asking permission."
    : "None attached. Do not claim documents are available on screen.";

  const knowledgeBlock = specs.knowledgeBases.length > 0
    ? `Approved knowledge retrieval is available from: ${specs.knowledgeBases.map((kb) => kb.name).join(", ")}. You MUST call search_knowledge(query, limit, topics) before stating a technical claim is correct, incorrect, or incomplete; teaching or extending a concept; recommending an approach; or making a technical judgment. Do not call it for neutral evidence-gathering questions, and reuse relevant results across adjacent turns.`
    : "No approved knowledge base is available. Do not call search_knowledge.";

  let resumeBlock = "";
  if (specs.resume) {
    const claims = specs.resume.claims ?? [];
    const claimList = claims.length > 0
      ? claims.slice(0, 30).map((c) => `- [${c.kind.toUpperCase()}] "${c.text}" (section: ${c.section}, anchor: "${c.anchor}"${c.metric ? `, metric: "${c.metric}"` : ""})`).join("\n")
      : "No structured claims extracted.";

    resumeBlock = `\nTHE CANDIDATE'S RESUME (verbatim reference text):
${specs.resume.extractedText.slice(0, 3500)}

RESUME CLAIM QUEUE & HIGHLIGHTING RULES:
1. One claim at a time: select an un-questioned claim from the queue below for your main question.
2. For impact or quantification rounds, prioritize claims with metrics.
3. Show-and-Tell Highlight: when asking about a claim, call surface with action 'open_pdf' and payload { fileId: '${specs.resume.documentId}', highlightQuery: '<anchor>' } so the candidate's PDF viewer highlights the exact line while you speak.
4. Drill into their specific technical contribution, mechanism, challenges, and ownership before moving to another claim. Never re-ask an already answered claim.

CLAIMS AVAILABLE TO PROBE:
${claimList}\n`;
  }

  const icebreakerBlock = specs.learnerHistory?.isReturning
    ? `LEARNER CONTEXT (RETURNING CANDIDATE):
- This learner has met with you before (last session: ${specs.learnerHistory.lastSessionDate ? new Date(specs.learnerHistory.lastSessionDate).toLocaleDateString() : "earlier"}).
- NEVER state a session number, session count, or invented history — your memory module surfaces real past exchanges; acknowledge familiarity naturally instead ("good to see you again").
- Turn 1: Welcome them back warmly, then follow the SAME-TURN CONTINUATION contract: if a document is attached, announce it ("I see you've shared your resume — let me take a look."), run read_document + surface open_pdf, then react to what the tools returned and end with your first question. If no document, one greeting message ending with ONE rapport question.
- Turn 2: Natural bridge right back into the scenario or their latest progress.
- Turn 3+: Continue technical scenario progression.`
    : `LEARNER CONTEXT (FIRST-TIME CANDIDATE):
- Spend the first 2-3 turns breaking the ice and establishing rapport before grilling with technical questions:
  * Turn 1 (Warm Greeting): Open their resume on screen (surface open_pdf) while greeting them warmly by name. Ask how their day is going or how they are feeling today. Vary your greeting phrasing naturally; NEVER repeat the same canned greeting across sessions.
  * Turn 2 (Rapport & Comfort): Respond genuinely to what they said, validate their feelings, normalize any interview nerves, and create a calm atmosphere.
  * Turn 3 (Natural Bridge): Bridge from pleasantries to the interview topic (e.g. "Awesome. Today we'll talk through your distributed systems experience and some projects from your resume. To kick off, what's been keeping you busy recently?").
  * Turn 4+: Deep-dive into specific technical verification and scenario progression.`;

  return `SESSION SPEC
Scenario: ${specs.agentName} (slug: ${specs.agentSlug})
Objective: ${specs.objective}
${specs.opening ? `Opening brief: ${specs.opening}` : ""}

${icebreakerBlock}

SAME-TURN CONTINUATION: multiple spoken messages within one turn are fine, but they are ONE continuous spoken turn. Ideal opening: with a document, message 1 = greeting + intent ("let me take a look", no question), then read_document + surface open_pdf, then message 2 = react to what the tools returned and end with your first question; without a document, one message ending with one rapport question. After a tool result the candidate has NOT spoken — NEVER speak for the candidate or answer your own question ("Things have been good…" is the candidate's line, not yours). Reaction openers ("Wonderful", "Good, good") are only for reacting to tool output. A pending question is the LAST thing in the turn — stop after it. Session numbers/counts are never stated.

INTERVIEW PROGRESSION (guidance, not a script — bridge topics naturally):
${phases}

APPROVED KNOWLEDGE:
${knowledgeBlock}

PERSONA: ${specs.personaName ?? specs.personaSlug ?? "Trainer"} (slug: ${specs.personaSlug ?? "trainer"})
${specs.personaVoice ? `How this trainer behaves and decides (from their indexed records): ${specs.personaVoice}` : ""}

ATTACHED ARTIFACTS FOR SHOW-AND-TELL & INSPECTION:
${docsBlock}
${resumeBlock}
OPERATING MODE: ${specs.mode === "voice" ? "VOICE CALL (Spoken-first, audio formatting strictly enforced, under 50 words)" : "TEXT CHAT (Interactive text conversation)"}`;
}
