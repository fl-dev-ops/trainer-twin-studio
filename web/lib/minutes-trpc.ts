import { TRPCError } from "@trpc/server";
import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/lib/db";
import { MAX_INVITES } from "@/lib/invite/emails";
import { inviteLearners } from "@/lib/invite/org";
import {
  creditsAdded,
  DEFAULT_LEARNER_MINUTES,
  grantMinutes,
  grantMinutesToMany,
  learnerMinutes,
  MAX_LEARNER_MINUTES,
  MinutesError,
  orgBalanceSeconds,
  orgCreditsAddedSeconds,
} from "@/lib/minutes";
import { STUDIO_ROLES, studioEmails } from "@/lib/org";
import { studioProcedure, t } from "@/lib/trpc";

/**
 * Credits (practice minutes; 1 credit = 1 minute) over /api/trpc (`minutes`): the org's balance and top-ups, a
 * learner's credits and what they were given, and adding credits to a learner. Studio only. Credits are only ever
 * added: every addition is a new ledger row, and balances are sums.
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

/** Credits are for learners: admin and team are never charged, so giving them credits would only waste the balance. */
async function assertLearner(orgId: string, email: string) {
  const studio = await db.member.findFirst({ where: { organizationId: orgId, role: { in: [...STUDIO_ROLES] }, user: { email: { equals: email, mode: "insensitive" } } }, select: { id: true } });
  if (studio) throw new MinutesError(`${email} is on the studio team; admin and team members practise without using credits.`, 400);
}

const toMinutes = (seconds: number) => Math.floor(seconds / 60);

export const minutesRouter = t.router({
  /** The org's credits: what it can still give out, everything added to it, and its top-ups (the Credits page). */
  org: studioProcedure.query(async ({ ctx }) => {
    const [balance, added, topups] = await Promise.all([
      orgBalanceSeconds(ctx.user.orgId),
      orgCreditsAddedSeconds(ctx.user.orgId),
      creditsAdded(ctx.user.orgId),
    ]);
    return {
      balanceMinutes: toMinutes(balance),
      addedMinutes: toMinutes(added),
      defaultMinutes: DEFAULT_LEARNER_MINUTES,
      maxMinutes: MAX_LEARNER_MINUTES,
      topups,
    };
  }),

  /** One learner's credits: left, given, used, and every credit added to them. */
  learner: studioProcedure.input(z.object({ email: emailInput })).query(async ({ ctx, input }) => {
    const [own, orgBalance, added] = await Promise.all([
      learnerMinutes(ctx.user.orgId, [input.email]).then((rows) => rows.get(input.email)!),
      orgBalanceSeconds(ctx.user.orgId),
      creditsAdded(ctx.user.orgId, input.email),
    ]);
    return {
      givenMinutes: toMinutes(own.grantedSeconds),
      usedMinutes: Math.round(own.usedSeconds / 6) / 10,
      balanceMinutes: toMinutes(Math.max(0, own.balanceSeconds)),
      maxMinutes: MAX_LEARNER_MINUTES,
      orgBalanceMinutes: toMinutes(orgBalance),
      added,
    };
  }),

  /**
   * Adds the same credits to several learners at once (the Users page). Admin and team, and anyone the add would take
   * past the per-learner cap, are skipped with the reason; the rest are all given or, when the balance is short, none.
   */
  addMany: studioProcedure
    .input(z.object({ emails: z.array(emailInput).min(1).max(100), minutes: amount, note }))
    .mutation(({ ctx, input }) => minutesCall(async () => {
      const staff = await studioEmails(ctx.user.orgId, input.emails);
      const result = await grantMinutesToMany({
        orgId: ctx.user.orgId,
        emails: input.emails.filter((email) => !staff.has(email)),
        minutes: input.minutes,
        actorUserId: ctx.user.id,
        note: input.note || "Added by trainer",
      });
      return { ...result, skipped: [...[...staff].map((email) => ({ email, reason: "is on the studio team (no credits needed)" })), ...result.skipped] };
    })),

  /** Invites learners to the org (Settings > Users) with their starting credits (lib/invite/org.ts). */
  invite: studioProcedure
    .input(z.object({ emails: z.array(emailInput).min(1).max(MAX_INVITES), minutes: amount.default(DEFAULT_LEARNER_MINUTES) }))
    .mutation(({ ctx, input }) => minutesCall(async () =>
      inviteLearners({ orgId: ctx.user.orgId, actorUserId: ctx.user.id, emails: input.emails, minutes: input.minutes, headers: await headers() }),
    )),

  /** Adds credits to a learner, on top of what they have, from the org's balance. */
  add: studioProcedure.input(z.object({ email: emailInput, minutes: amount, note })).mutation(({ ctx, input }) => minutesCall(async () => {
    await assertLearner(ctx.user.orgId, input.email);
    return grantMinutes({ orgId: ctx.user.orgId, email: input.email, minutes: input.minutes, actorUserId: ctx.user.id, note: input.note || "Added by trainer" });
  })),
});
