import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { MAX_INVITES } from "@/lib/invite/emails";
import type { CreditGrant } from "@/lib/meteroid";
import {
  creditsAdded,
  type CreditEntry,
  DEFAULT_LEARNER_MINUTES,
  learnerBalance,
  learnerMinutes,
  MAX_LEARNER_MINUTES,
  MinutesError,
} from "@/lib/minutes";
import { LEARNER, orgPeople } from "@/lib/org-people";
import { hasUnsentUsage, orgCredits, orgGrants, refreshOrgCredits } from "@/lib/org-credits";
import { scheduleOrgUsage } from "@/lib/schedule-org-credits";
import { runAddOrgPeople, runGiveCredits } from "@/lib/workflow-runs";
import { studioProcedure, t } from "@/lib/trpc";
import { activity, type UsageRow } from "@/lib/usage-report";

/**
 * Credits (practice minutes; 1 credit = 1 minute) over /api/trpc (`minutes`): the org's balance and what was added to
 * it (from Meteroid, lib/org-credits.ts), a learner's credits and what they were given, and adding credits to a
 * learner. Studio only. Learners' credits are only ever added: every addition is a new ledger row, and balances are sums.
 */

const emailInput = z.string().trim().toLowerCase().email().max(320);
const amount = z.number().int().min(1).max(MAX_LEARNER_MINUTES);
const note = z.string().trim().max(200).optional();

async function minutesCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MinutesError) {
      throw new TRPCError({ code: error.status === 409 ? "CONFLICT" : error.status === 403 ? "FORBIDDEN" : "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}

const toMinutes = (seconds: number) => Math.floor(seconds / 60);

/** Meteroid's balance and grants are read again when the copy is older than this (page loads). */
const STALE_MS = 60_000;

/**
 * What a grant is, in words a customer understands: reasons are internal (staff free text, Razorpay ids), so they're not
 * shown. Minute packs are Meteroid's PURCHASE grants (their reason is checked too, for copies cached without `source`).
 */
export function grantLabel(grant: Pick<CreditGrant, "reason" | "source">) {
  if (grant.reason === "Free trial") return "Free trial";
  if (grant.source === "PURCHASE" || grant.reason === "Credit purchased on a paid invoice") return "Minute pack";
  if (grant.reason?.startsWith("Paid ") && grant.reason.includes("Razorpay")) return "Purchase"; // phase 1 (lib/credit-purchases.ts)
  return "From TrainerTwin";
}

/** A Meteroid grant as a row of the Usage page's "Credits added": what it is, and when it expires (or expired). */
function grantEntry(grant: CreditGrant): CreditEntry {
  return { id: grant.id, minutes: grant.minutes, note: grantLabel(grant), at: grant.createdAt ?? "", by: null, expiresAt: grant.expiresAt, expired: grant.status === "EXPIRED" };
}

/** The grant that expires next (still active), for the Usage page's balance card. */
function nextExpiry(grants: CreditGrant[], now = Date.now()) {
  const next = grants
    .filter((grant) => grant.status !== "EXPIRED" && grant.expiresAt && new Date(grant.expiresAt).getTime() > now)
    .sort((a, b) => a.expiresAt!.localeCompare(b.expiresAt!))[0];
  return next ? { minutes: next.minutes, label: grantLabel(next), at: next.expiresAt! } : null;
}

// shortcut: the log shows the newest 500 movements of the range (totals use every row); page server-side if orgs outgrow it.
const LOG_LIMIT = 500;

/** Keeps the org's copy of Meteroid fresh enough for a page, and sends usage a failed workflow left behind. */
async function freshEnough(orgId: string) {
  const synced = await orgGrants(orgId);
  if (!synced || (synced.syncedAt && Date.now() - synced.syncedAt.getTime() < STALE_MS)) return;
  await refreshOrgCredits(orgId).catch((error: unknown) => console.error(`[org-credits] ${orgId}: refresh failed:`, error));
  if (await hasUnsentUsage(orgId)) await scheduleOrgUsage(orgId);
}

export const minutesRouter = t.router({
  /**
   * The org's credits (the Credits page): what it can still spend, what was added to it (Meteroid grants), and each
   * learner's totals (given, used, left), lowest left first. Admin and team are left out: they don't hold credits.
   */
  org: studioProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    await freshEnough(orgId);
    const [credits, synced, perLearner] = await Promise.all([orgCredits(orgId), orgGrants(orgId), learnerMinutes(orgId)]);
    const grants = synced?.grants ?? [];
    const emails = [...perLearner.keys()];
    // The org's learners (lib/org-people.ts) who hold credits; admin and team don't.
    const people = emails.length ? await orgPeople(orgId, { roles: [LEARNER], emails, includeDisabled: true }) : [];
    const personByEmail = new Map(people.map((person) => [person.email, person]));
    const learners = [...perLearner.values()]
      .filter((row) => personByEmail.has(row.email))
      .map((row) => {
        const person = personByEmail.get(row.email)!;
        return {
          email: row.email,
          userId: person.userId,
          name: person.name,
          image: person.image,
          givenMinutes: toMinutes(row.grantedSeconds),
          usedMinutes: Math.round(row.usedSeconds / 6) / 10,
          leftMinutes: toMinutes(Math.max(0, row.balanceSeconds)),
        };
      })
      .sort((a, b) => a.leftMinutes - b.leftMinutes || a.email.localeCompare(b.email));
    return {
      billed: credits.billed,
      balanceMinutes: Math.max(0, credits.minutes),
      addedMinutes: grants.reduce((sum, grant) => sum + grant.minutes, 0),
      nextExpiry: nextExpiry(grants),
      defaultMinutes: DEFAULT_LEARNER_MINUTES,
      maxMinutes: MAX_LEARNER_MINUTES,
      grants: grants.map(grantEntry),
      learners,
    };
  }),

  /**
   * The Usage page's Details (the last `days` days, by UTC date): per twin / role play, per team member, and every credit movement (lib/usage-report.ts). Database only: no Meteroid call.
   */
  activity: studioProcedure.input(z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]) })).query(async ({ ctx, input }) => {
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (input.days - 1)));
    const rows = await db.$queryRaw<UsageRow[]>`
      SELECT l."id", l."type", l."seconds", l."email", l."userId", l."actorUserId", l."note", l."createdAt",
        a."id" AS "agentId", a."name" AS "agentName", a."kind"::text AS kind, (c."id" IS NOT NULL) AS calibration
      FROM "MinuteLedger" l
      LEFT JOIN "InterviewSession" s ON s."id" = l."sessionId"
      LEFT JOIN "Agent" a ON a."id" = s."agentId"
      LEFT JOIN "TwinCalibration" c ON c."sessionId" = s."id"
      WHERE l."orgId" = ${ctx.user.orgId} AND l."type" IN ('grant', 'reclaim', 'usage', 'org_usage') AND l."createdAt" >= ${since}
      ORDER BY l."createdAt" DESC`;
    const report = activity(rows, input.days);
    const log = report.log.slice(0, LOG_LIMIT);
    const ids = [...new Set([...log.flatMap((entry) => [entry.personId, entry.byId]), ...report.team.map((person) => person.userId)].filter((id): id is string => Boolean(id)))];
    const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
    const nameOf = new Map(users.map((user) => [user.id, user.name || user.email]));
    return {
      ...report,
      team: report.team.map((person) => ({ ...person, name: (person.userId && nameOf.get(person.userId)) || person.email || "Someone" })),
      log: log.map((entry) => ({ ...entry, person: (entry.personId && nameOf.get(entry.personId)) || entry.personEmail, by: entry.byId ? nameOf.get(entry.byId) ?? null : null })),
      logTotal: report.log.length,
    };
  }),

  /**
   * A fingerprint of the org's credits: Meteroid's last balance and grants, and the last movement in the ledger. The
   * studio polls it (cheap: no Meteroid call) and reloads credit numbers when it changes, so a grant made in Meteroid
   * (webhook → workflow → OrgBilling) or a call that ended shows up within seconds.
   */
  version: studioProcedure.query(async ({ ctx }) => {
    const [billing, last] = await Promise.all([
      db.orgBilling.findUnique({ where: { orgId: ctx.user.orgId }, select: { balanceMinutes: true, grants: true } }),
      db.minuteLedger.findFirst({ where: { orgId: ctx.user.orgId }, orderBy: { createdAt: "desc" }, select: { id: true } }),
    ]);
    const grants = (billing?.grants ?? []) as { id: string; status: string | null }[];
    return [billing?.balanceMinutes ?? "-", grants.map((grant) => `${grant.id}:${grant.status}`).join(","), last?.id ?? "-"].join("|");
  }),

  /** One learner's credits: left, given, used, and every credit added to them. */
  learner: studioProcedure.input(z.object({ email: emailInput })).query(async ({ ctx, input }) => {
    const [own, credits, added] = await Promise.all([
      learnerMinutes(ctx.user.orgId, [input.email]).then((rows) => rows.get(input.email)!),
      orgCredits(ctx.user.orgId),
      creditsAdded(ctx.user.orgId, input.email),
    ]);
    return {
      givenMinutes: toMinutes(own.grantedSeconds),
      usedMinutes: Math.round(own.usedSeconds / 6) / 10,
      balanceMinutes: toMinutes(Math.max(0, own.balanceSeconds)),
      maxMinutes: MAX_LEARNER_MINUTES,
      orgBalanceMinutes: Math.max(0, credits.minutes),
      added,
    };
  }),

  /**
   * Adds the same credits to several learners at once (the Users page). Admin and team, and anyone the add would take
   * past the per-learner cap, are skipped with the reason; the rest are all given or, when the balance is short, none.
   */
  addMany: studioProcedure
    .input(z.object({ emails: z.array(emailInput).min(1).max(100), minutes: amount, note }))
    .mutation(({ ctx, input }) => minutesCall(() =>
      // The give-credits workflow (workflows/give-credits.ts): credits, then a "credits added" email each.
      runGiveCredits({ org: { id: ctx.user.orgId, slug: ctx.user.orgSlug }, by: { id: ctx.user.id, name: ctx.user.name }, emails: input.emails, minutes: input.minutes, note: input.note }),
    )),

  /**
   * Adds people to the org (Settings › Team and Users; specs/people.md): members right away, learners with their
   * starting credits, one email each (lib/invite/org.ts).
   */
  addPeople: studioProcedure
    .input(z.object({ emails: z.array(emailInput).min(1).max(MAX_INVITES), role: z.enum(["team", "user"]), minutes: amount.optional() }))
    .mutation(({ ctx, input }) => minutesCall(async () => {
      const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.user.orgId }, select: { id: true, slug: true, name: true } });
      // The add-org-people workflow (workflows/add-org-people.ts): members, starting credits, emails.
      return runAddOrgPeople({ org, by: { id: ctx.user.id, name: ctx.user.name }, emails: input.emails, role: input.role, minutes: input.minutes });
    })),

  /** Adds credits to one learner, on top of what they have, from the org's balance, and emails them. */
  add: studioProcedure.input(z.object({ email: emailInput, minutes: amount, note })).mutation(({ ctx, input }) => minutesCall(async () => {
    const result = await runGiveCredits({ org: { id: ctx.user.orgId, slug: ctx.user.orgSlug }, by: { id: ctx.user.id, name: ctx.user.name }, emails: [input.email], minutes: input.minutes, note: input.note });
    if (result.skipped.length) throw new MinutesError(`${result.skipped[0].email} ${result.skipped[0].reason}.`, 400);
    const own = await learnerBalance(ctx.user.orgId, input.email);
    return { grantedMinutes: input.minutes, balanceMinutes: Math.floor(own.balanceSeconds / 60), orgBalanceMinutes: result.orgBalanceMinutes ?? 0 };
  })),
});
