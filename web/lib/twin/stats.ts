/** Pure helpers behind the twin pages: transcripts, first exchange, weekly counts, calibration rates. */

export type Turn = { who: "learner" | "twin"; text: string };

/** A saved transcript as turns. Learner lines are `role: "user"`; everything else is the twin speaking. */
export function transcriptTurns(transcript: unknown): Turn[] {
  if (!Array.isArray(transcript)) return [];
  return transcript.flatMap((item) => {
    const turn = item as { role?: unknown; speaker?: unknown; text?: unknown };
    const text = typeof turn.text === "string" ? turn.text.trim() : "";
    if (!text) return [];
    const learner = turn.role === "user" || turn.speaker === "learner";
    return [{ who: learner ? "learner" as const : "twin" as const, text }];
  });
}

/** The learner's first question and the twin's reply to it (for list rows). */
export function firstExchange(turns: Turn[]): { question: string | null; answer: string | null } {
  const at = turns.findIndex((turn) => turn.who === "learner");
  if (at < 0) return { question: null, answer: null };
  return { question: turns[at].text, answer: turns.slice(at + 1).find((turn) => turn.who === "twin")?.text ?? null };
}

export function durationSeconds(startedAt: Date | null, endedAt: Date | null): number | null {
  if (!startedAt || !endedAt) return null;
  const seconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
  return seconds > 0 ? Math.round(seconds) : null;
}

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Conversations per day for the last 7 days, oldest first, ending today (UTC days). */
export function lastSevenDays(dates: Date[], now = new Date()): { label: string; value: number }[] {
  const today = Math.floor(now.getTime() / DAY);
  return Array.from({ length: 7 }, (_, i) => {
    const day = today - 6 + i;
    return {
      label: WEEKDAYS[new Date(day * DAY).getUTCDay()],
      value: dates.filter((date) => Math.floor(date.getTime() / DAY) === day).length,
    };
  });
}

/** Share of "feels like me" among rated replies, per week for the last `weeks` weeks (null: nothing rated). */
export function likeRateByWeek(ratings: { rating: string; at: Date }[], weeks = 6, now = new Date()): (number | null)[] {
  const end = now.getTime();
  return Array.from({ length: weeks }, (_, i) => {
    const from = end - (weeks - i) * 7 * DAY;
    const inWeek = ratings.filter(({ at }) => at.getTime() > from && at.getTime() <= from + 7 * DAY);
    if (!inWeek.length) return null;
    return Math.round((inWeek.filter(({ rating }) => rating === "like").length / inWeek.length) * 100);
  });
}

/**
 * Most asked questions across a twin's sessions, top `limit`, highest count first (ties: first asked wins).
 * shortcut: exact text match (case/space-insensitive); group similar wordings only if counts come out fragmented.
 */
export function mostAsked(questionLists: string[][], limit = 3): { question: string; count: number }[] {
  const counts = new Map<string, { question: string; count: number }>();
  for (const questions of questionLists) {
    const seen = new Set<string>();
    for (const question of questions) {
      const key = question.toLowerCase().replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { question: question.trim(), count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/** A list title from the first thing the trainer said. */
export function titleFrom(text: string | null | undefined, fallback: string): string {
  const line = text?.replace(/\s+/g, " ").trim();
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
