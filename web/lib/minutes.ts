import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { DEFAULT_LEARNER_MINUTES, MAX_LEARNER_MINUTES } from "@/lib/minutes-config";

/**
 * Prepaid practice minutes (MinuteLedger). TrainerTwin tops an org up; the org gives its learners minutes from that
 * balance; learner calls (twin and role play alike) use them, by the second. Admin and team are never charged. This
 * module is the only writer of the ledger: every balance below is a sum over it, plus calls still running.
 */

export { DEFAULT_LEARNER_MINUTES, MAX_LEARNER_MINUTES };

export class MinutesError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MinutesError";
  }
}

export const OUT_OF_MINUTES = "You've used all your practice minutes. Ask your trainer for more.";

type Tx = Prisma.TransactionClient | typeof db;
const lower = (email: string) => email.trim().toLowerCase();
const minutes = (seconds: number) => Math.floor(seconds / 60);

/** The org's unallocated balance: top-ups minus what it has given out (take-backs come back). */
export async function orgBalanceSeconds(orgId: string, tx: Tx = db): Promise<number> {
  const [row] = await tx.$queryRaw<{ seconds: number }[]>`
    SELECT coalesce(sum(CASE WHEN "type" = 'topup' THEN "seconds" ELSE -"seconds" END), 0)::int AS seconds
    FROM "MinuteLedger" WHERE "orgId" = ${orgId} AND "type" IN ('topup', 'grant', 'reclaim')`;
  return row?.seconds ?? 0;
}

export type LearnerMinutes = { email: string; grantedSeconds: number; usedSeconds: number; balanceSeconds: number };

/**
 * Learners' minutes: given (grants minus take-backs) and used (finished calls, plus calls still running up to now).
 * A running call never counts more than the balance it started with (allowedSeconds), so a call that never closed
 * cannot keep using minutes. Without `emails`: every learner of the org with ledger rows or metered calls.
 */
export async function learnerMinutes(orgId: string, emails?: string[], tx: Tx = db): Promise<Map<string, LearnerMinutes>> {
  const wanted = emails?.map(lower);
  if (wanted && wanted.length === 0) return new Map();
  const emailFilter = wanted ? Prisma.sql`AND "email" IN (${Prisma.join(wanted)})` : Prisma.empty;
  const userFilter = wanted ? Prisma.sql`AND lower(u."email") IN (${Prisma.join(wanted)})` : Prisma.empty;
  const [ledger, live] = await Promise.all([
    tx.$queryRaw<{ email: string; granted: number; used: number }[]>`
      SELECT "email",
        coalesce(sum("seconds") FILTER (WHERE "type" IN ('grant', 'reclaim')), 0)::int AS granted,
        coalesce(-sum("seconds") FILTER (WHERE "type" = 'usage'), 0)::int AS used
      FROM "MinuteLedger" WHERE "orgId" = ${orgId} AND "email" IS NOT NULL ${emailFilter}
      GROUP BY "email"`,
    // Metered calls without a usage row yet (running, or closed by a path that didn't record it).
    tx.$queryRaw<{ email: string; seconds: number }[]>`
      SELECT lower(u."email") AS email, coalesce(sum(greatest(0, least(s."allowedSeconds",
        floor(extract(epoch FROM (coalesce(s."endedAt", now() AT TIME ZONE 'UTC') - s."startedAt")))))), 0)::int AS seconds
      FROM "InterviewSession" s JOIN "user" u ON u."id" = s."userId"
      WHERE s."orgId" = ${orgId} AND s."allowedSeconds" IS NOT NULL AND s."startedAt" IS NOT NULL
        AND s."status" NOT IN ('failed', 'revoked')
        AND NOT EXISTS (SELECT 1 FROM "MinuteLedger" m WHERE m."sessionId" = s."id") ${userFilter}
      GROUP BY lower(u."email")`,
  ]);
  const result = new Map<string, LearnerMinutes>();
  const entry = (email: string) => {
    let row = result.get(email);
    if (!row) result.set(email, (row = { email, grantedSeconds: 0, usedSeconds: 0, balanceSeconds: 0 }));
    return row;
  };
  for (const row of ledger) Object.assign(entry(row.email), { grantedSeconds: row.granted, usedSeconds: row.used });
  for (const row of live) entry(row.email).usedSeconds += row.seconds;
  for (const row of wanted ?? []) entry(row);
  for (const row of result.values()) row.balanceSeconds = row.grantedSeconds - row.usedSeconds;
  return result;
}

export async function learnerBalance(orgId: string, email: string, tx: Tx = db): Promise<LearnerMinutes> {
  return (await learnerMinutes(orgId, [email], tx)).get(lower(email))!;
}

/**
 * What studio lists show per person: credits left and given, in whole minutes, or null for anyone on the org's
 * studio team (admin and team practise without using credits).
 */
export async function creditsLeftFor(orgId: string, emails: string[]): Promise<Map<string, { left: number; given: number } | null>> {
  const wanted = [...new Set(emails.map(lower))];
  const [minutes, studio] = await Promise.all([
    learnerMinutes(orgId, wanted),
    db.member.findMany({ where: { organizationId: orgId, role: { in: ["admin", "team"] } }, select: { user: { select: { email: true } } } }),
  ]);
  const staff = new Set(studio.map((row) => row.user.email.toLowerCase()));
  return new Map(wanted.map((email) => {
    const own = minutes.get(email);
    return [email, staff.has(email) ? null : { left: Math.floor(Math.max(0, own?.balanceSeconds ?? 0) / 60), given: Math.floor((own?.grantedSeconds ?? 0) / 60) }];
  }));
}

/** Grants, take-backs and top-ups of one org run one at a time, so two admins can't spend the same minutes. */
async function locked<T>(orgId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`minutes:${orgId}`}))`;
    return work(tx);
  });
}

function wholeMinutes(value: number) {
  if (!Number.isInteger(value) || value < 1) throw new MinutesError("Give a whole number of minutes, 1 or more", 400);
  return value;
}

/** TrainerTwin adds minutes to an org's balance (the top-up script now; payments later). */
export async function topUpOrg(input: { orgId: string; minutes: number; note: string; actorUserId?: string | null }) {
  const amount = wholeMinutes(input.minutes);
  return locked(input.orgId, async (tx) => {
    await tx.minuteLedger.create({ data: { orgId: input.orgId, type: "topup", seconds: amount * 60, note: input.note, actorUserId: input.actorUserId ?? null } });
    return { orgBalanceMinutes: minutes(await orgBalanceSeconds(input.orgId, tx)) };
  });
}

/**
 * Gives a learner minutes from the org's balance. Refused when the org balance is short or the learner would hold
 * more than MAX_LEARNER_MINUTES in total. `onlyIfNew`: a no-op for someone who was already given minutes (invites
 * and assignments give the starting minutes once).
 */
export async function grantMinutes(input: {
  orgId: string;
  email: string;
  minutes: number;
  actorUserId?: string | null;
  userId?: string | null;
  note?: string | null;
  onlyIfNew?: boolean;
}): Promise<{ grantedMinutes: number; balanceMinutes: number; orgBalanceMinutes: number }> {
  const amount = wholeMinutes(input.minutes);
  const email = lower(input.email);
  return locked(input.orgId, async (tx) => {
    const learner = await learnerBalance(input.orgId, email, tx);
    const orgBalance = await orgBalanceSeconds(input.orgId, tx);
    if (input.onlyIfNew) {
      const given = await tx.minuteLedger.count({ where: { orgId: input.orgId, email, type: "grant" } });
      if (given > 0) return { grantedMinutes: 0, balanceMinutes: minutes(learner.balanceSeconds), orgBalanceMinutes: minutes(orgBalance) };
    }
    if (orgBalance < amount * 60) {
      throw new MinutesError(`Not enough minutes in your organization's balance: ${minutes(orgBalance)} min left. Ask TrainerTwin to top it up.`, 409);
    }
    const room = MAX_LEARNER_MINUTES * 60 - learner.grantedSeconds;
    if (amount * 60 > room) {
      throw new MinutesError(`${email} can be given at most ${MAX_LEARNER_MINUTES} minutes in total; ${minutes(Math.max(0, room))} more is possible.`, 400);
    }
    await tx.minuteLedger.create({
      data: { orgId: input.orgId, email, userId: input.userId ?? null, type: "grant", seconds: amount * 60, actorUserId: input.actorUserId ?? null, note: input.note ?? null },
    });
    return { grantedMinutes: amount, balanceMinutes: minutes(learner.balanceSeconds + amount * 60), orgBalanceMinutes: minutes(orgBalance - amount * 60) };
  });
}

/**
 * The starting credits for people invited or assigned: `minutes` each (DEFAULT_LEARNER_MINUTES unless the trainer chose),
 * once per person (someone already given credits gets nothing more). All or nothing: refused when the org balance
 * can't cover everyone new.
 */
export async function giveStartingMinutes(input: { orgId: string; emails: string[]; minutes?: number; actorUserId?: string | null }) {
  const amount = input.minutes ?? DEFAULT_LEARNER_MINUTES;
  wholeMinutes(amount);
  if (amount > MAX_LEARNER_MINUTES) throw new MinutesError(`A learner can be given at most ${MAX_LEARNER_MINUTES} minutes in total.`, 400);
  const emails = [...new Set(input.emails.map(lower))];
  if (!emails.length) return { given: [] as string[] };
  return locked(input.orgId, async (tx) => {
    const had = await tx.minuteLedger.findMany({ where: { orgId: input.orgId, type: "grant", email: { in: emails } }, select: { email: true }, distinct: ["email"] });
    const known = new Set(had.map((row) => row.email));
    const given = emails.filter((email) => !known.has(email));
    const need = given.length * amount * 60;
    const orgBalance = await orgBalanceSeconds(input.orgId, tx);
    if (need > orgBalance) {
      throw new MinutesError(
        `Not enough credits in your organization's balance: ${given.length} new ${given.length === 1 ? "person needs" : "people need"} ${minutes(need)} min, ${minutes(orgBalance)} min left. Ask TrainerTwin to top it up.`,
        409,
      );
    }
    if (given.length) {
      await tx.minuteLedger.createMany({
        data: given.map((email) => ({ orgId: input.orgId, email, type: "grant", seconds: amount * 60, actorUserId: input.actorUserId ?? null, note: "Starting minutes" })),
      });
    }
    return { given };
  });
}

/**
 * Adds the same credits to several learners at once, from the org's balance. Anyone it would take past
 * MAX_LEARNER_MINUTES in total is skipped (and said why); the rest are all given, or none when the org balance can't
 * cover them.
 */
export async function grantMinutesToMany(input: { orgId: string; emails: string[]; minutes: number; actorUserId?: string | null; note?: string | null }) {
  const amount = wholeMinutes(input.minutes);
  const emails = [...new Set(input.emails.map(lower))];
  return locked(input.orgId, async (tx) => {
    const balances = await learnerMinutes(input.orgId, emails, tx);
    const given: string[] = [];
    const skipped: { email: string; reason: string }[] = [];
    for (const email of emails) {
      const room = MAX_LEARNER_MINUTES * 60 - (balances.get(email)?.grantedSeconds ?? 0);
      if (amount * 60 > room) skipped.push({ email, reason: `can get at most ${minutes(Math.max(0, room))} more (${MAX_LEARNER_MINUTES} min in total)` });
      else given.push(email);
    }
    const orgBalance = await orgBalanceSeconds(input.orgId, tx);
    if (given.length * amount * 60 > orgBalance) {
      throw new MinutesError(
        `Not enough credits in your organization's balance: ${given.length} × ${amount} min = ${given.length * amount} min, ${minutes(orgBalance)} min left. Ask TrainerTwin to top it up.`,
        409,
      );
    }
    if (given.length) {
      await tx.minuteLedger.createMany({
        data: given.map((email) => ({ orgId: input.orgId, email, type: "grant", seconds: amount * 60, actorUserId: input.actorUserId ?? null, note: input.note ?? null })),
      });
    }
    return { given, skipped, orgBalanceMinutes: minutes(orgBalance - given.length * amount * 60) };
  });
}

/**
 * Takes unused minutes back from a learner into the org's balance (never more than they have left). Not exposed in
 * the studio (credits are only ever added there); kept for support corrections.
 */
export async function reclaimMinutes(input: { orgId: string; email: string; minutes: number; actorUserId?: string | null; note?: string | null }) {
  const amount = wholeMinutes(input.minutes);
  const email = lower(input.email);
  return locked(input.orgId, async (tx) => {
    const learner = await learnerBalance(input.orgId, email, tx);
    if (amount * 60 > learner.balanceSeconds) {
      throw new MinutesError(`${email} has ${minutes(Math.max(0, learner.balanceSeconds))} unused minutes; take back at most that.`, 400);
    }
    await tx.minuteLedger.create({
      data: { orgId: input.orgId, email, type: "reclaim", seconds: -amount * 60, actorUserId: input.actorUserId ?? null, note: input.note ?? null },
    });
    return { reclaimedMinutes: amount, balanceMinutes: minutes(learner.balanceSeconds - amount * 60), orgBalanceMinutes: minutes(await orgBalanceSeconds(input.orgId, tx)) };
  });
}

/** Seconds a closed metered call used: start to end, never more than the balance it started with. */
export function sessionUsageSeconds(row: { allowedSeconds: number | null; startedAt: Date | null; endedAt: Date | null; status: string }) {
  if (row.allowedSeconds == null || !row.startedAt || !row.endedAt || row.status === "failed" || row.status === "revoked") return 0;
  return Math.max(0, Math.min(row.allowedSeconds, Math.floor((row.endedAt.getTime() - row.startedAt.getTime()) / 1000)));
}

/** Writes a closed metered call's usage row. Safe to call more than once (one usage row per session). */
export async function recordSessionUsage(sessionId: string) {
  const row = await db.interviewSession.findUnique({
    where: { id: sessionId },
    select: { id: true, orgId: true, userId: true, allowedSeconds: true, startedAt: true, endedAt: true, status: true, user: { select: { email: true } } },
  });
  if (!row || row.allowedSeconds == null || !row.endedAt) return;
  const seconds = sessionUsageSeconds(row);
  await db.minuteLedger.create({
    data: { orgId: row.orgId, email: lower(row.user.email), userId: row.userId, type: "usage", seconds: -seconds, sessionId: row.id },
  }).catch((error: unknown) => {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  });
}

/** One credit added: to the org (a top-up) or to a learner (a grant), with who added it. */
export type CreditEntry = { id: string; minutes: number; note: string | null; at: string; by: string | null };

/**
 * Credits added, newest first: the org's top-ups (no email), or what one learner was given. Each addition is its own
 * row and balances are sums, so this is the full record; nothing is ever changed in place.
 */
export async function creditsAdded(orgId: string, email?: string, take = 200): Promise<CreditEntry[]> {
  const rows = await db.minuteLedger.findMany({
    where: { orgId, ...(email ? { email: lower(email), type: "grant" } : { type: "topup" }) },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, seconds: true, note: true, createdAt: true, actorUserId: true },
  });
  const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } }) : [];
  const nameOf = new Map(actors.map((actor) => [actor.id, actor.name || actor.email]));
  return rows.map((row) => ({
    id: row.id,
    minutes: Math.floor(row.seconds / 60),
    note: row.note,
    at: row.createdAt.toISOString(),
    by: row.actorUserId ? nameOf.get(row.actorUserId) ?? null : null,
  }));
}

/** Total credits ever added to the org (its top-ups). */
export async function orgCreditsAddedSeconds(orgId: string): Promise<number> {
  const total = await db.minuteLedger.aggregate({ where: { orgId, type: "topup" }, _sum: { seconds: true } });
  return total._sum.seconds ?? 0;
}
