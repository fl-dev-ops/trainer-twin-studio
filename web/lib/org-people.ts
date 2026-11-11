import { randomUUID } from "node:crypto";
import { db, withLock } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { DEFAULT_LEARNER_MINUTES, giveStartingMinutes, minutesLock } from "@/lib/minutes";
import { isValidInviteEmail } from "@/lib/invite/emails";
import { ADMIN_ROLE, isStudioRole, LEARNER_ROLE, STUDIO_ROLES, type OrgRole } from "@/lib/roles";
import { scheduleOrgUsage } from "@/lib/schedule-org-credits";

/**
 * An org's people (specs/people.md): an account (`user`), then a member of the org with a role, then (elsewhere) the
 * twins and role plays given to that member. The only place that lists, looks up or adds an org's people; everything
 * in web/ goes through here (tests/lib/org-people-architecture.test.ts keeps it that way).
 */

export type PersonRole = OrgRole;
export const ADMIN: PersonRole = ADMIN_ROLE;
export const LEARNER: PersonRole = LEARNER_ROLE;
const STUDIO: PersonRole[] = [...STUDIO_ROLES];

export type OrgPerson = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: PersonRole;
  disabled: boolean;
  disabledAt: Date | null;
  addedAt: Date;
};

/** A people refusal (specs/people.md Refusals). */
export class PeopleError extends AppError {}

/** The lock every change to one org's people takes (specs/people.md rule 17), after minutesLock when both are held. */
export const peopleLock = (orgId: string) => `people:${orgId}`;

export const peopleRefusals = {
  invalidEmail: (emails: string[]) => new PeopleError("invalid_email", `Not a valid email: ${emails.join(", ")}`, 400),
  personDisabled: (emails: string[]) =>
    new PeopleError("person_disabled", `${emails.join(", ")} ${emails.length === 1 ? "is" : "are"} disabled in this organization. Re-enable them first.`, 409),
  personIsStudio: (emails: string[]) =>
    new PeopleError("person_is_studio", `${emails.join(", ")} ${emails.length === 1 ? "is" : "are"} on the team. Team members practise with the organization's credits, not as learners.`, 409),
  oneAdmin: () => new PeopleError("one_admin", "This organization already has an admin. Add people as team or learner.", 409),
};

type Db = Prisma.TransactionClient | typeof db;
const lower = (email: string) => email.trim().toLowerCase();

const select = {
  id: true,
  role: true,
  createdAt: true,
  disabledAt: true,
  user: { select: { id: true, name: true, email: true, image: true } },
} as const;

type Row = { id: string; role: string; createdAt: Date; disabledAt: Date | null; user: { id: string; name: string; email: string; image: string | null } };
const toPerson = (row: Row): OrgPerson => ({
  memberId: row.id,
  userId: row.user.id,
  name: row.user.name || row.user.email,
  email: row.user.email.toLowerCase(),
  image: row.user.image,
  role: row.role as PersonRole,
  disabled: row.disabledAt !== null,
  disabledAt: row.disabledAt,
  addedAt: row.createdAt,
});

/**
 * The org's people, oldest first. Disabled people are left out unless `includeDisabled`. Narrow with `roles`, `emails`
 * (case-insensitive), `userIds` or `memberIds`.
 */
export async function orgPeople(
  orgId: string,
  filter: { roles?: PersonRole[]; includeDisabled?: boolean; emails?: string[]; userIds?: string[]; memberIds?: string[] } = {},
  tx: Db = db,
): Promise<OrgPerson[]> {
  const rows = await tx.member.findMany({
    where: {
      organizationId: orgId,
      ...(filter.roles ? { role: { in: filter.roles } } : {}),
      ...(filter.includeDisabled ? {} : { disabledAt: null }),
      ...(filter.userIds ? { userId: { in: filter.userIds } } : {}),
      ...(filter.memberIds ? { id: { in: filter.memberIds } } : {}),
      ...(filter.emails ? { user: { email: { in: [...new Set(filter.emails.map(lower))], mode: "insensitive" as const } } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select,
  });
  return rows.map(toPerson);
}

/** One person in the org (disabled included), by account, member or email; null when they aren't in it. */
export async function orgPerson(orgId: string, by: { userId: string } | { memberId: string } | { email: string }, tx: Db = db) {
  const where =
    "userId" in by ? { userId: by.userId }
    : "memberId" in by ? { id: by.memberId }
    : { user: { email: { equals: lower(by.email), mode: "insensitive" as const } } };
  const row = await tx.member.findFirst({ where: { organizationId: orgId, ...where }, select });
  return row ? toPerson(row) : null;
}

/** The org's admin and team, lower-cased emails (they practise from the org's credits, not their own). */
export async function studioPeopleEmails(orgId: string, emails?: string[]) {
  return new Set((await orgPeople(orgId, { roles: STUDIO, includeDisabled: true, emails })).map((person) => person.email));
}

export type AddedPerson = OrgPerson & {
  /** Became a member just now. */
  added: boolean;
  /** Starting credits given just now (learners new to the org's credits); 0 otherwise. */
  startingCredits: number;
};

/**
 * Adds people to the org (specs/people.md rules 1, 2, 7, 8, 9, 17): creates each account that doesn't exist, then makes
 * it a member with `role`. One transaction under the org's locks, all or nothing: refused for invalid emails, a second
 * admin, disabled members, and (for learners) people already on the studio team. Someone already in the org keeps
 * their role. Learners added by this call get their starting credits (`startingMinutes`, default
 * DEFAULT_LEARNER_MINUTES) from the org's balance; refused (MinutesError) when it can't cover them. Returns everyone,
 * `added` marking new members.
 */
export async function addPeopleToOrg(input: {
  orgId: string;
  emails: string[];
  role: PersonRole;
  /** Who is adding them (credits ledger). */
  byUserId?: string | null;
  startingMinutes?: number;
  /** More writes for these people (their twin or role-play assignments) in the same locked transaction. */
  then?: (tx: Prisma.TransactionClient, people: AddedPerson[]) => Promise<void>;
}): Promise<AddedPerson[]> {
  const emails = [...new Set(input.emails.map(lower))].filter(Boolean);
  if (!emails.length) return [];
  const invalid = emails.filter((email) => !isValidInviteEmail(email));
  if (invalid.length) throw peopleRefusals.invalidEmail(invalid);

  const result = await withLock([minutesLock(input.orgId), peopleLock(input.orgId)], async (tx) => {
    const existing = await orgPeople(input.orgId, { emails, includeDisabled: true }, tx);
    const disabled = existing.filter((person) => person.disabled).map((person) => person.email);
    if (disabled.length) throw peopleRefusals.personDisabled(disabled);
    if (input.role === LEARNER) {
      const studio = existing.filter((person) => isStudioRole(person.role)).map((person) => person.email);
      if (studio.length) throw peopleRefusals.personIsStudio(studio);
    }
    const known = new Map(existing.map((person) => [person.email, person]));
    const fresh = emails.filter((email) => !known.has(email));
    if (input.role === ADMIN && fresh.length && (fresh.length > 1 || (await orgPeople(input.orgId, { roles: [ADMIN], includeDisabled: true }, tx)).length)) {
      throw peopleRefusals.oneAdmin();
    }
    // Starting credits only for learners this call adds; when the org can't cover them, nobody is added.
    const credited = new Set(input.role === LEARNER && fresh.length
      ? (await giveStartingMinutes(tx, { orgId: input.orgId, emails: fresh, minutes: input.startingMinutes, actorUserId: input.byUserId ?? null })).given
      : []);
    const userIds = await accountsFor(fresh, tx);
    if (fresh.length) {
      await tx.member.createMany({
        data: fresh.map((email) => ({ id: randomUUID(), organizationId: input.orgId, userId: userIds.get(email)!, role: input.role, createdAt: new Date() })),
      });
    }
    const added = new Map((await orgPeople(input.orgId, { emails: fresh }, tx)).map((person) => [person.email, person]));
    const people = emails.map((email): AddedPerson => {
      const startingCredits = credited.has(email) ? input.startingMinutes ?? DEFAULT_LEARNER_MINUTES : 0;
      return added.has(email) ? { ...added.get(email)!, added: true, startingCredits } : { ...known.get(email)!, added: false, startingCredits };
    });
    await input.then?.(tx, people);
    return people;
  });
  if (result.some((person) => person.startingCredits)) await scheduleOrgUsage(input.orgId);
  return result;
}

/** The account for each email (lower-cased), created when there is none (name: the part before @). */
async function accountsFor(emails: string[], tx: Prisma.TransactionClient) {
  const find = async () => new Map((await tx.user.findMany({
    where: { OR: emails.map((email) => ({ email: { equals: email, mode: "insensitive" as const } })) },
    select: { id: true, email: true },
  })).map((user) => [user.email.toLowerCase(), user.id]));
  if (!emails.length) return new Map<string, string>();
  const found = await find();
  const missing = emails.filter((email) => !found.has(email));
  if (!missing.length) return found;
  // Created by another org at the same moment: the unique email keeps one, and this finds it.
  await tx.user.createMany({
    data: missing.map((email) => ({ id: randomUUID(), email, name: email.split("@")[0] || email, emailVerified: false })),
    skipDuplicates: true,
  });
  return find();
}
