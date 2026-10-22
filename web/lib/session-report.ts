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

/** Points awarded for one rubric criterion of a role play. */
export type RubricScore = {
  criterion: string;
  points: number;
  maxPoints: number;
  reason: string;
};

export type SessionReport = {
  summary: string;
  summaryTags: string[];
  keyMoments: KeyMoment[];
  focusNextTime: string;
  /** For role plays with a rubric, the sum of `rubricScores` points. */
  score?: number;
  rubricScores?: RubricScore[];
  generatedAt: string;
};

export type SessionReportStatus = "none" | "generating" | "failed" | "completed";

export function normalizeSessionReportStatus(value: unknown, hasValidReport: boolean): SessionReportStatus {
  if (hasValidReport) return "completed";
  return value === "generating" || value === "failed" ? value : "none";
}

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
      description: "Up to 3 substantive learner moments selected from the body of the session; excludes procedural opening and closing exchanges.",
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

const RUBRIC_SCORES_JSON_SCHEMA = {
  type: "array",
  description: "One entry per rubric criterion, in the order given, scoring only the learner.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["criterion", "points", "reason"],
    properties: {
      criterion: { type: "string", description: "The rubric criterion name, exactly as given." },
      points: { type: "number", description: "Points awarded, from 0 up to the criterion's maximum." },
      reason: { type: "string", description: "One sentence citing what the learner did or missed." },
    },
  },
};

/** Report schema; role plays with a rubric also return per-criterion points. */
export function sessionReportJsonSchema(withRubric: boolean) {
  if (!withRubric) return SESSION_REPORT_JSON_SCHEMA;
  return {
    ...SESSION_REPORT_JSON_SCHEMA,
    required: [...SESSION_REPORT_JSON_SCHEMA.required, "rubricScores"],
    properties: { ...SESSION_REPORT_JSON_SCHEMA.properties, rubricScores: RUBRIC_SCORES_JSON_SCHEMA },
  };
}

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
