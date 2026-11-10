import { orgPerson } from "@/lib/org-people";
import { resolveSessionUser } from "@/lib/session-user";

/**
 * Who may upload here: an enabled member of the org (specs/people.md: learners are members before any twin or role
 * play, and a shared twin link adds them when its page opens). Null otherwise.
 */
export async function uploader() {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return null;
  const member = await orgPerson(org.id, { userId: user.id });
  return member && !member.disabled ? { org, user } : null;
}
