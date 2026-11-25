/**
 * Twin calibration scores, for the TrainerTwin team (never shown to coaches): per twin, the score after each of the
 * coach's completed packs (worked out from the packs, nothing stored), with answers, accuracy, the Wilson 95% interval
 * and its margin, reliable or not, the "What was off?" reasons and per topic. `--latest` gives one row per twin.
 *
 *   bun scripts/calibration-score-report.ts [--latest] > calibration-scores.csv
 */
import { db } from "@/lib/db";
import { twinScoreHistory } from "@/lib/twin/calibration-cards";

const latestOnly = process.argv.includes("--latest");
// Twins with any completed pack (team packs drop out in the history: only the coach's count).
const twins = await db.agent.findMany({
  where: { calibrationPacks: { some: { status: "complete" } } },
  select: { id: true, name: true, slug: true, orgId: true },
  orderBy: { name: "asc" },
});
// Agents keep only the org's id: the names come from the organization table.
const orgNames = new Map((await db.organization.findMany({
  where: { id: { in: [...new Set(twins.map((twin) => twin.orgId).filter((id): id is string => Boolean(id)))] } },
  select: { id: true, name: true },
})).map((org) => [org.id, org.name]));

const pct = (x: number) => (x * 100).toFixed(1);
const cell = (value: string | number | boolean) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
console.log(["org", "twin", "slug", "completed_at", "packs_done", "answers", "liked", "accuracy_pct", "wilson_low_pct", "wilson_high_pct", "margin_pts", "reliable", "off_advice", "off_facts", "off_style", "off_scope", "topics"].join(","));
for (const twin of twins) {
  if (!twin.orgId) continue;
  const history = await twinScoreHistory(twin.orgId, twin.id);
  for (const row of latestOnly ? history.slice(-1) : history) {
    const interval = row.wilson;
    console.log([
      orgNames.get(twin.orgId) ?? "", twin.name, twin.slug, row.completedAt?.toISOString() ?? "", row.packsDone, row.answers, row.liked,
      row.answers ? pct(row.liked / row.answers) : "", interval ? pct(interval.low) : "", interval ? pct(interval.high) : "",
      interval ? ((interval.high - interval.low) * 50).toFixed(1) : "", row.reliable,
      row.reasons.advice, row.reasons.facts, row.reasons.style, row.reasons.scope,
      row.topics.map((topic) => `${topic.topic} ${topic.liked}/${topic.answers}`).join("; "),
    ].map(cell).join(","));
  }
}
process.exit(0);
