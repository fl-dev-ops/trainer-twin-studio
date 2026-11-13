import { db } from "@/lib/db";
import { refusals } from "@/lib/errors";
import type { ExternalApiContext } from "@/lib/external-api";
import { grantMinutes, learnerBalance, type LearnerMinutes } from "@/lib/minutes";
import { MAX_LEARNER_MINUTES } from "@/lib/minutes-config";
import { orgCredits } from "@/lib/org-credits";
import { LEARNER, orgPerson } from "@/lib/org-people";
import { personEmailFor } from "@/lib/invite/person-email";
import { deliverEmail } from "@/lib/queue-emails";

/** Credits are minutes, with fractional minutes retained rather than hiding spent seconds. */
export function learnerCreditsView(balance?: LearnerMinutes) {
  return {
    givenMinutes: (balance?.grantedSeconds ?? 0) / 60,
    usedMinutes: (balance?.usedSeconds ?? 0) / 60,
    balanceMinutes: Math.max(0, balance?.balanceSeconds ?? 0) / 60,
    maxLearnerMinutes: MAX_LEARNER_MINUTES,
  };
}

export async function readLearnerCredits(orgId: string, userId: string) {
  const person = await orgPerson(orgId, { userId });
  if (!person || person.disabled || person.role !== LEARNER) throw refusals.notFound();
  return { userId, ...learnerCreditsView(await learnerBalance(orgId, person.email)) };
}

/** Allocate once, then notify. A retry returns the same immutable grant, with current balances and no second email. */
export async function grantLearnerCreditsByApi(api: ExternalApiContext, userId: string, input: { minutes: number; note?: string }, requestKey: string) {
  const person = await orgPerson(api.org.id, { userId });
  if (!person) throw refusals.notFound();
  // grantMinutes rechecks membership/role under minutes -> people locks and compares the complete retry payload.
  const granted = await grantMinutes({
    orgId: api.org.id, userId, email: person.email, minutes: input.minutes,
    note: input.note ?? null, actorUserId: api.actorUserId, requestKey,
  });
  const [row, balance, available] = await Promise.all([
    db.minuteLedger.findUniqueOrThrow({
      where: { orgId_requestKey: { orgId: api.org.id, requestKey } },
      select: { id: true, userId: true, seconds: true, note: true, createdAt: true },
    }),
    learnerBalance(api.org.id, person.email),
    orgCredits(api.org.id),
  ]);
  let emailSent = false;
  if (granted.grantedMinutes) {
    try {
      const email = personEmailFor({
        person: { ...person, added: false, startingCredits: 0 },
        org: api.org, by: { name: api.trainer.name }, key: `credits:${row.id}`,
        balance: Math.floor(Math.max(0, balance.balanceSeconds) / 60), creditsAdded: input.minutes,
      });
      emailSent = (await deliverEmail({ ...email, idempotencyKey: `credits:${row.id}` })).sent;
    } catch (error) {
      console.error(`[api] credit grant ${row.id} saved, but notification failed:`, error);
    }
  }
  return {
    grant: { id: row.id, userId: row.userId, minutes: row.seconds / 60, note: row.note, createdAt: row.createdAt },
    created: granted.grantedMinutes > 0,
    balanceMinutes: Math.max(0, balance.balanceSeconds) / 60,
    orgBalanceMinutes: Math.max(0, available.seconds) / 60,
    emailSent,
  };
}
