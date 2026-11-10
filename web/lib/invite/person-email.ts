import { db } from "@/lib/db";
import type { PersonEmailArgs } from "@/lib/email";
import { signInUrl } from "@/lib/invite/links";
import type { AddedPerson } from "@/lib/org-people";
import type { OutboundEmail } from "@/workflows/send-emails";

/** The org's name, for emails. */
export async function orgName(orgId: string) {
  return (await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } })).name;
}

/**
 * The last day of an end date set as "end of the chosen day" in the assigner's time zone, as "30 Nov 2026".
 * shortcut: the time zone isn't stored, so the day is read 12 hours earlier in UTC (right for UTC−11 to UTC+12); store
 * the chosen day if anyone further out uses end dates.
 */
export const lastDay = (accessUntil: Date | null | undefined) =>
  accessUntil
    ? new Date(accessUntil.getTime() - 12 * 3600_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : null;

/**
 * One person's email for one action (specs/people.md rule 11): "added" when they joined the org just now, plus what
 * the action gave them. `balance`: their credits after it (learners). The key makes each email go out once per event.
 */
export function personEmailFor(input: {
  person: AddedPerson;
  org: { slug: string; name: string };
  by: { name: string };
  key: string;
  twin?: PersonEmailArgs["twin"];
  roleplay?: PersonEmailArgs["roleplay"];
  balance?: number;
  creditsAdded?: number;
}): OutboundEmail {
  const { person } = input;
  const creditsAdded = input.creditsAdded ?? (person.startingCredits || undefined);
  return {
    kind: "person",
    idempotencyKey: input.key,
    args: {
      to: person.email,
      orgName: input.org.name,
      byName: input.by.name,
      ...(person.added ? { added: { role: person.role, signInUrl: signInUrl(person.role, input.org.slug) } } : {}),
      ...(input.twin ? { twin: input.twin } : {}),
      ...(input.roleplay ? { roleplay: input.roleplay } : {}),
      ...(input.balance !== undefined ? { credits: { added: creditsAdded, balance: input.balance } } : {}),
    },
  };
}
