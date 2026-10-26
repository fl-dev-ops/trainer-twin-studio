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

/** Whether the learner met one role-play learner goal. */
export type GoalResult = {
  goal: string;
  status: "met" | "partly" | "not_met";
  evidence: string;
};

export type SessionReport = {
  summary: string;
  summaryTags: string[];
  keyMoments: KeyMoment[];
  focusNextTime: string;
  /** For role plays with a rubric, the sum of `rubricScores` points. */
  score?: number;
  rubricScores?: RubricScore[];
  /** Role plays only: one result per learner goal, in the order configured. */
  goalResults?: GoalResult[];
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

const GOAL_RESULTS_JSON_SCHEMA = {
  type: "array",
  description: "One entry per learner goal, in the order given.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "status", "evidence"],
    properties: {
      goal: { type: "string", description: "The learner goal, exactly as given." },
      status: { type: "string", enum: ["met", "partly", "not_met"], description: "met: clearly did it; partly: attempted but not fully; not_met: did not do it." },
      evidence: { type: "string", description: "One sentence citing what the learner said or did." },
    },
  },
};

/** Report schema; role plays also return per-goal results and, with a rubric, per-criterion points. */
export function sessionReportJsonSchema(options: { rubric: boolean; goals: boolean }) {
  if (!options.rubric && !options.goals) return SESSION_REPORT_JSON_SCHEMA;
  return {
    ...SESSION_REPORT_JSON_SCHEMA,
    required: [
      ...SESSION_REPORT_JSON_SCHEMA.required,
      // Goals first: the model writes fields in order, so rubric points follow the goal results.
      ...(options.goals ? ["goalResults"] : []),
      ...(options.rubric ? ["rubricScores"] : []),
    ],
    properties: {
      ...SESSION_REPORT_JSON_SCHEMA.properties,
      ...(options.goals ? { goalResults: GOAL_RESULTS_JSON_SCHEMA } : {}),
      ...(options.rubric ? { rubricScores: RUBRIC_SCORES_JSON_SCHEMA } : {}),
    },
  };
}

/** Rubric points earned and available, e.g. 74 of 100. */
export function rubricTotals(rows: RubricScore[]): { earned: number; max: number } {
  return {
    earned: rows.reduce((sum, row) => sum + row.points, 0),
    max: rows.reduce((sum, row) => sum + row.maxPoints, 0),
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
