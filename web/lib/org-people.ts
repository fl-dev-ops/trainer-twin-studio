import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { DEFAULT_LEARNER_MINUTES, giveStartingMinutes } from "@/lib/minutes";
import { isValidInviteEmail } from "@/lib/invite/emails";

/**
 * An org's people (specs/people.md): an account (`user`), then a member of the org with a role, then (elsewhere) the
 * twins and role plays given to that member. The only place that lists, looks up or adds an org's people; everything
 * in web/ goes through here (tests/lib/org-people-architecture.test.ts keeps it that way).
 */

export type PersonRole = "admin" | "team" | "user";
export const ADMIN: PersonRole = "admin";
export const LEARNER: PersonRole = "user";
const STUDIO: PersonRole[] = ["admin", "team"];
const isStudio = (role: string) => STUDIO.includes(role as PersonRole);

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

export class PeopleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PeopleError";
  }
}

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
 * Adds people to the org (specs/people.md rules 1, 2, 7, 8, 9): creates each account that doesn't exist, then makes
 * it a member with `role`. All or nothing, checked before anything is written: refused for invalid emails, a second
 * admin, disabled members, and (for learners) people already on the studio team. Someone already in the org keeps
 * their role. New learners get their starting credits (`startingMinutes`, default DEFAULT_LEARNER_MINUTES) from the
 * org's balance; refused (MinutesError) when it can't cover them. Returns everyone, `added` marking new members.
 */
export async function addPeopleToOrg(input: {
  orgId: string;
  emails: string[];
  role: PersonRole;
  /** Who is adding them (credits ledger). */
  byUserId?: string | null;
  startingMinutes?: number;
}): Promise<AddedPerson[]> {
  const emails = [...new Set(input.emails.map(lower))].filter(Boolean);
  if (!emails.length) return [];
  const invalid = emails.filter((email) => !isValidInviteEmail(email));
  if (invalid.length) throw new PeopleError(`Not a valid email: ${invalid.join(", ")}`);

  const existing = await orgPeople(input.orgId, { emails, includeDisabled: true });
  const disabled = existing.filter((person) => person.disabled).map((person) => person.email);
  if (disabled.length) throw new PeopleError(`Disabled in this organization (re-enable them in Settings first): ${disabled.join(", ")}`, 409);
  if (input.role === LEARNER) {
    const studio = existing.filter((person) => isStudio(person.role)).map((person) => person.email);
    if (studio.length) throw new PeopleError(`Already on the studio team (they practise from the organization's credits): ${studio.join(", ")}`, 409);
  }
  const known = new Map(existing.map((person) => [person.email, person]));
  const fresh = emails.filter((email) => !known.has(email));
  if (input.role === ADMIN && fresh.length) {
    if (fresh.length > 1 || (await orgPeople(input.orgId, { roles: [ADMIN], includeDisabled: true })).length) {
      throw new PeopleError("An organization has exactly one admin. Add people as team or user.", 403);
    }
  }

  // Starting credits first: when the org can't cover them, nobody is added.
  const credited = input.role === LEARNER
    ? new Set((await giveStartingMinutes({ orgId: input.orgId, emails, minutes: input.startingMinutes, actorUserId: input.byUserId ?? null })).given)
    : new Set<string>();
  const credits = (email: string) => (credited.has(email) ? input.startingMinutes ?? DEFAULT_LEARNER_MINUTES : 0);

  const added: AddedPerson[] = [];
  for (const email of fresh) {
    const userId = await accountFor(email);
    await db.member
      .create({ data: { id: randomUUID(), organizationId: input.orgId, userId, role: input.role, createdAt: new Date() } })
      .catch((error: unknown) => {
        // Added twice at once: the unique (org, account) keeps one.
        if (!isUniqueViolation(error)) throw error;
      });
    const person = await orgPerson(input.orgId, { userId });
    if (person) added.push({ ...person, added: true, startingCredits: credits(person.email) });
  }
  const addedEmails = new Set(added.map((person) => person.email));
  return emails.map((email) =>
    addedEmails.has(email) ? added.find((person) => person.email === email)! : { ...known.get(email)!, added: false, startingCredits: credits(email) });
}

/** The account for this email, created when there is none (name: the part before @). */
async function accountFor(email: string) {
  const found = await db.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
  if (found) return found.id;
  try {
    const user = await db.user.create({
      data: { id: randomUUID(), email, name: email.split("@")[0] || email, emailVerified: false },
      select: { id: true },
    });
    return user.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return (await db.user.findFirstOrThrow({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } })).id;
  }
}

const isUniqueViolation = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
