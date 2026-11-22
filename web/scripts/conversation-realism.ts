/**
 * Human-likeness markers of the AI side of role-play conversations (output of interview-skill-chat-check.ts), from
 * conversation research: real speakers are terse (many turns of a few words), rarely praise or use dashes, do not end
 * every turn with a question, and do not restate the other person. Lower assistant-style rates are more human.
 *
 *   bun scripts/conversation-realism.ts <report.json> [...]
 */
import { readFileSync } from "node:fs";

const PRAISE = /\b(great|good|excellent|fair|solid|interesting) (question|point|answer|call|catch)\b|\bthat makes (total |complete )?sense\b|\bi (completely |totally )?understand\b|\bi appreciate\b|\babsolutely\b/i;
const RESTATE = /\b(so (what )?you'?re saying|it sounds like|if i understand|so you mean)\b/i;

export function realism(replies: string[]) {
  const n = replies.length || 1;
  const words = replies.map((r) => r.split(/\s+/).filter(Boolean).length);
  const sorted = [...words].sort((a, b) => a - b);
  const pct = (f: (r: string, i: number) => boolean) => Math.round((replies.filter(f).length / n) * 100);
  return {
    turns: replies.length,
    medianWords: sorted[Math.floor(sorted.length / 2)] ?? 0,
    shortTurnsPct: pct((_, i) => words[i] <= 6),
    endsWithQuestionPct: pct((r) => /\?\s*$/.test(r.trim())),
    praisePct: pct((r) => PRAISE.test(r)),
    restatePct: pct((r) => RESTATE.test(r)),
    dashPct: pct((r) => /—|–| - /.test(r)),
    multiQuestionPct: pct((r) => (r.match(/\?/g) ?? []).length > 1),
  };
}

if (import.meta.main) {
  const all: string[] = [];
  for (const file of process.argv.slice(2)) {
    const text = readFileSync(file, "utf8");
    const at = text.indexOf('{\n  "org"');
    if (at < 0) continue;
    const report = JSON.parse(text.slice(at)) as { results: { agent: string; turns: { heard: string; reply: string }[] }[] };
    for (const r of report.results) {
      const replies = r.turns.slice(1).map((t) => t.reply); // skip the opening line
      all.push(...replies);
      console.log(r.agent.padEnd(48), JSON.stringify(realism(replies)));
    }
  }
  console.log("ALL".padEnd(48), JSON.stringify(realism(all)));
}
