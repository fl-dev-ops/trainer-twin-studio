/**
 * The Usage page's numbers, from MinuteLedger rows joined to their call (pure: no database here, see lib/minutes-trpc.ts).
 * An org's credits leave it when they're given to a learner (grant) or spent by an admin or team call (org_usage);
 * learner calls (usage) then use the minutes they were given.
 */

export const CATEGORIES = ["assigned", "learnerTwin", "learnerRoleplay", "calibration", "teamTwin", "teamRoleplay"] as const;
export type UsageCategory = (typeof CATEGORIES)[number];

export type UsageRow = {
  id: string;
  type: string;
  seconds: number;
  email: string | null;
  userId: string | null;
  actorUserId: string | null;
  note: string | null;
  createdAt: Date;
  agentId: string | null;
  agentName: string | null;
  kind: string | null; // TWIN | ROLEPLAY
  calibration: boolean;
};

export function categoryOf(row: Pick<UsageRow, "type" | "kind" | "calibration">): UsageCategory | null {
  if (row.type === "grant" || row.type === "reclaim") return "assigned";
  const roleplay = row.kind === "ROLEPLAY";
  if (row.type === "usage") return roleplay ? "learnerRoleplay" : "learnerTwin";
  if (row.type === "org_usage") return row.calibration ? "calibration" : roleplay ? "teamRoleplay" : "teamTwin";
  return null; // old topup / refund rows: from before Meteroid, not part of this picture
}

const toMinutes = (seconds: number) => Math.round(seconds / 60);
const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

export type ActivityLogEntry = {
  id: string;
  at: string;
  category: UsageCategory;
  minutes: number;
  /** The learner given minutes or who called (email; names are filled in by the caller). */
  personEmail: string | null;
  personId: string | null;
  /** Who gave the minutes (grants). */
  byId: string | null;
  agent: string | null;
  note: string | null;
};

/** The Usage page's Details for a period: totals, per twin / role play, per team member, and the log. */
export function activity(rows: UsageRow[], days: number) {
  const totals = zero(CATEGORIES);
  const agents = new Map<string, { id: string; name: string; kind: string; calls: number; learnerSeconds: number; teamSeconds: number }>();
  const team = new Map<string, { userId: string | null; email: string | null; calibration: number; twins: number; roleplays: number }>();
  const log: ActivityLogEntry[] = [];

  for (const row of rows) {
    const category = categoryOf(row);
    if (!category) continue;
    const seconds = Math.abs(row.seconds);
    // Reclaims (historical) took minutes back from a learner: a negative "assigned". Calls are shown as positive minutes.
    const signed = category === "assigned" ? row.seconds : seconds;
    totals[category] += signed;
    log.push({
      id: row.id,
      at: row.createdAt.toISOString(),
      category,
      minutes: Math.round(signed / 6) / 10,
      personEmail: row.email,
      personId: row.userId,
      byId: row.actorUserId,
      agent: row.agentName,
      note: row.note,
    });
    if (category === "assigned") continue;
    if (row.agentId) {
      const agent = agents.get(row.agentId) ?? { id: row.agentId, name: row.agentName ?? "Deleted", kind: row.kind ?? "TWIN", calls: 0, learnerSeconds: 0, teamSeconds: 0 };
      agent.calls += 1;
      if (row.type === "usage") agent.learnerSeconds += seconds;
      else agent.teamSeconds += seconds;
      agents.set(row.agentId, agent);
    }
    if (row.type === "org_usage") {
      const key = row.userId ?? row.email ?? "?";
      const person = team.get(key) ?? { userId: row.userId, email: row.email, calibration: 0, twins: 0, roleplays: 0 };
      if (category === "calibration") person.calibration += seconds;
      else if (category === "teamRoleplay") person.roleplays += seconds;
      else person.twins += seconds;
      team.set(key, person);
    }
  }

  return {
    days,
    totals: Object.fromEntries(CATEGORIES.map((key) => [key, toMinutes(Math.max(0, totals[key]))])) as Record<UsageCategory, number>,
    agents: [...agents.values()]
      .map(({ learnerSeconds, teamSeconds, ...agent }) => ({ ...agent, learnerMinutes: toMinutes(learnerSeconds), teamMinutes: toMinutes(teamSeconds) }))
      .sort((a, b) => b.learnerMinutes + b.teamMinutes - (a.learnerMinutes + a.teamMinutes)),
    team: [...team.values()]
      .map((person) => ({
        userId: person.userId,
        email: person.email,
        calibration: toMinutes(person.calibration),
        twins: toMinutes(person.twins),
        roleplays: toMinutes(person.roleplays),
        total: toMinutes(person.calibration + person.twins + person.roleplays),
      }))
      .sort((a, b) => b.total - a.total),
    log,
  };
}
