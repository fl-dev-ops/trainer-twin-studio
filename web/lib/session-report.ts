export type KeyMoment = {
  id: string;
  number: string;
  timestamp: string;
  seconds?: number;
  title: string;
  quote: string;
  description: string;
  audioUrl?: string;
};

export type SessionReport = {
  summary: string;
  summaryTags: string[];
  keyMoments: KeyMoment[];
  focusNextTime: string;
  score?: number;
  generatedAt: string;
};

export const SESSION_REPORT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "summaryTags", "keyMoments", "focusNextTime"],
  properties: {
    summary: {
      type: "string",
      description: "Concise narrative summary of the learner's performance and core observations.",
    },
    summaryTags: {
      type: "array",
      items: { type: "string" },
      description: "2 to 4 concise tags summarizing key outcomes or competencies evaluated.",
    },
    keyMoments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "timestamp", "seconds", "title", "quote", "description"],
        properties: {
          number: { type: "string", description: "Sequential moment number, e.g. '01', '02', '03'." },
          timestamp: { type: "string", description: "Formatted timestamp in minutes and seconds, e.g. '2:18'." },
          seconds: { type: "number", description: "Timestamp in seconds from session start." },
          title: { type: "string", description: "Short title of the moment, e.g. 'Claim and baseline'." },
          quote: { type: "string", description: "Verbatim or near-verbatim quote spoken by the learner." },
          description: { type: "string", description: "Why this moment was notable or what it demonstrated." },
        },
      },
      description: "Exactly 3 distinct moments selected from the session conversation.",
    },
    focusNextTime: {
      type: "string",
      description: "Actionable, specific guidance for the learner's next practice conversation.",
    },
    score: {
      type: "number",
      description: "Optional overall rating from 0 to 100.",
    },
  },
};

export function isSessionReport(value: unknown): value is SessionReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summary === "string" &&
    Array.isArray(v.summaryTags) &&
    Array.isArray(v.keyMoments) &&
    typeof v.focusNextTime === "string"
  );
}
