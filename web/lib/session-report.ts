export type KeyMoment = {
  id: string;
  number: string;
  /** Seconds into the session recording where the quoted turn was spoken, from the transcript's own timing. */
  at?: number;
  /** "m:ss" and seconds of `at`. Reports made before `at` existed hold a model's guess here: don't show or seek those. */
  timestamp?: string;
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
  /** Role plays with a rubric: the rubric total as 0-100. */
  score?: number;
  /** Role plays only: one row per rubric criterion, in the order configured. */
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
        required: ["number", "turn", "title", "quote", "description"],
        properties: {
          number: { type: "string", description: "Sequential moment number, e.g. '01', '02', '03'." },
          turn: { type: "integer", description: "The [number] of the transcript line the quote comes from." },
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

/** When the session video starts (epoch ms): the recording's first frame (saved by the agent webhook), else the session start. */
export function recordingStartOf(evidence: unknown, startedAt: Date | null | undefined): number | null {
  const recorded = evidence && typeof evidence === "object" ? (evidence as Record<string, unknown>).recordingStartedAt : undefined;
  return typeof recorded === "number" && Number.isFinite(recorded) ? recorded : startedAt?.getTime() ?? null;
}

/** A transcript line as the report model sees it, with when it was spoken (epoch ms) when the transcript has it. */
export type ReportTurn = { speaker: string; learner: boolean; text: string; spokenAt?: number };

/** The transcript for the report model, one numbered line per turn ("[3] Learner: ..."), so a key moment can cite its turn. */
export function numberedTranscript(turns: ReportTurn[]) {
  return turns.map((turn, index) => `[${index + 1}] ${turn.speaker}: ${turn.text}`).join("\n\n");
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);

/** Share of the quote's words found in the turn: the quote is "verbatim or near-verbatim". */
function overlap(quote: string, turn: string) {
  const wanted = words(quote);
  if (!wanted.size) return 0;
  const have = words(turn);
  let found = 0;
  for (const word of wanted) if (have.has(word)) found++;
  return found / wanted.size;
}

const minutesSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * The model's key moments with their real place in the recording. The model only says which numbered turn it quotes;
 * the time is that turn's `spokenAt` minus when the recording started. A cited turn that doesn't hold the quote falls
 * back to the learner turn that does; with no matching turn or no timing, the moment has no time rather than a guess.
 */
export function placeKeyMoments(sessionId: string, raw: unknown, turns: ReportTurn[], recordingStart: number | null): KeyMoment[] {
  const moments = Array.isArray(raw) ? (raw as Array<Partial<KeyMoment> & { turn?: unknown }>) : [];
  return moments.slice(0, 3).map((moment, index) => {
    const quote = typeof moment.quote === "string" ? moment.quote : "";
    const cited = Number.isInteger(moment.turn) ? turns[(moment.turn as number) - 1] : undefined;
    const best = turns
      .filter((turn) => turn.learner)
      .map((turn) => ({ turn, score: overlap(quote, turn.text) }))
      .sort((a, b) => b.score - a.score)[0];
    const turn = cited && overlap(quote, cited.text) >= 0.6 ? cited : best && best.score >= 0.6 ? best.turn : undefined;
    const at = turn?.spokenAt !== undefined && recordingStart !== null ? Math.max(0, Math.round((turn.spokenAt - recordingStart) / 1000)) : undefined;
    return {
      id: `${sessionId}-m${index + 1}`,
      number: typeof moment.number === "string" ? moment.number : String(index + 1).padStart(2, "0"),
      title: typeof moment.title === "string" ? moment.title : "",
      quote,
      description: typeof moment.description === "string" ? moment.description : "",
      ...(at !== undefined ? { at, seconds: at, timestamp: minutesSeconds(at) } : {}),
    };
  });
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
