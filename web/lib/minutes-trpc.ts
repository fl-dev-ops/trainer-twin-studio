import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  DEFAULT_LEARNER_MINUTES,
  grantMinutes,
  learnerMinutes,
  ledgerHistory,
  MAX_LEARNER_MINUTES,
  MinutesError,
  orgBalanceSeconds,
  reclaimMinutes,
} from "@/lib/minutes";
import { STUDIO_ROLES } from "@/lib/org";
import { studioProcedure, t } from "@/lib/trpc";

/** Practice minutes over /api/trpc (`minutes`): the org's balance, a learner's minutes, and giving / taking back. Studio only. */

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

/** Minutes are for learners: admin and team are never charged, so giving them minutes would only waste the balance. */
async function assertLearner(orgId: string, email: string) {
  const studio = await db.member.findFirst({ where: { organizationId: orgId, role: { in: [...STUDIO_ROLES] }, user: { email: { equals: email, mode: "insensitive" } } }, select: { id: true } });
  if (studio) throw new MinutesError(`${email} is on the studio team; admin and team members practise without using minutes.`, 400);
}

const toMinutes = (seconds: number) => Math.floor(seconds / 60);

export const minutesRouter = t.router({
  /** The org's balance (what it can still give out), the defaults, and its recent top-ups and grants. */
  org: studioProcedure.query(async ({ ctx }) => ({
    balanceMinutes: toMinutes(await orgBalanceSeconds(ctx.user.orgId)),
    defaultMinutes: DEFAULT_LEARNER_MINUTES,
    maxMinutes: MAX_LEARNER_MINUTES,
    history: await ledgerHistory(ctx.user.orgId, undefined, 50),
  })),

  /** One learner's minutes: given, used, left, and every movement. */
  learner: studioProcedure.input(z.object({ email: emailInput })).query(async ({ ctx, input }) => {
    const own = (await learnerMinutes(ctx.user.orgId, [input.email])).get(input.email)!;
    return {
      givenMinutes: toMinutes(own.grantedSeconds),
      usedMinutes: Math.round(own.usedSeconds / 6) / 10,
      balanceMinutes: toMinutes(Math.max(0, own.balanceSeconds)),
      maxMinutes: MAX_LEARNER_MINUTES,
      orgBalanceMinutes: toMinutes(await orgBalanceSeconds(ctx.user.orgId)),
      history: await ledgerHistory(ctx.user.orgId, input.email),
    };
  }),

  /** Gives a learner more minutes from the org's balance. */
  add: studioProcedure.input(z.object({ email: emailInput, minutes: amount, note })).mutation(({ ctx, input }) => minutesCall(async () => {
    await assertLearner(ctx.user.orgId, input.email);
    return grantMinutes({ orgId: ctx.user.orgId, email: input.email, minutes: input.minutes, actorUserId: ctx.user.id, note: input.note || "Added by trainer" });
  })),

  /** Takes a learner's unused minutes back into the org's balance. */
  takeBack: studioProcedure.input(z.object({ email: emailInput, minutes: amount, note })).mutation(({ ctx, input }) => minutesCall(() =>
    reclaimMinutes({ orgId: ctx.user.orgId, email: input.email, minutes: input.minutes, actorUserId: ctx.user.id, note: input.note || "Taken back by trainer" }))),
});
