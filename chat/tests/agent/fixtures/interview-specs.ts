import type { SessionSpecs } from "../../../agent/lib/brain";

/** An interview role play as Vasanth's v1 agents run it (kind ROLEPLAY, no skill): every block of the interview spec filled. */
export const interviewSpecs: SessionSpecs = {
  sessionId: "sess_interview",
  agentName: "Frontend mock interview",
  agentSlug: "cwv-frontend-mock",
  agentVersion: 3,
  objective: "Assess frontend fundamentals",
  phases: [
    { name: "Warm-up", objective: "Rapport and background", knowledge_tags: ["intro"] },
    { name: "Core", objective: "JavaScript closures and the event loop", policy: "{\"follow_ups\":2}" },
  ],
  opening: "Greet and ask how they are",
  instruction: "Be warm but rigorous",
  interviewSettings: "- Type: verbal\n- Main questions: 4",
  interviewType: "verbal",
  behavioralRules: "- Claim handling mode: probe",
  agentPolicy: "{\"name\":\"Frontend mock interview\"}",
  personaName: "Vasanth",
  personaSlug: "vasanth",
  personaVersion: 2,
  personaVoice: "{\"style\":\"warm\"}",
  documents: [{ kind: "pdf", id: "doc_1", name: "resume.pdf", pageCount: 2, headings: ["Experience"] }] as SessionSpecs["documents"],
  expectedArtifact: { label: "Résumé", prompt: "Upload your current résumé as a PDF.", required: true },
  resume: {
    documentId: "doc_1",
    extractedText: "Built a React dashboard used by 2,000 people.",
    claims: [{ kind: "impact", text: "Built a React dashboard", section: "Experience", anchor: "React dashboard", metric: "2,000 users" }] as never,
  },
  warmOpening: { style: { phrasingStyle: [{ text: "Hey, good to see you", score: 0.9 }], pastExchanges: [{ exchange: "How's your day going?", score: 0.8 }] } },
  learnerName: "Harini",
  learnerHistory: { isReturning: true, pastSessionCount: 2, lastSessionDate: null },
  uiState: { active: "pdf", key: "doc_1", updatedAt: "2026-11-06T10:00:00.000Z" },
  mode: "voice",
  knowledgeBases: [{ slug: "frontend", name: "Frontend" }],
  clientTools: ["surface", "read_document"],
};
