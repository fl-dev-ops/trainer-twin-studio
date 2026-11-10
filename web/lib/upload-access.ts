import { beforeSettings } from "@/lib/context-upload";
import { db } from "@/lib/db";
import { orgPerson } from "@/lib/org-people";
import { resolveSessionUser } from "@/lib/session-user";
import { twinAccessByCode } from "@/lib/twin-access";

/**
 * Someone not yet in the org may upload through a twin code they can use (not consuming it), when the twin takes
 * files. Joining the org happens when the session starts.
 */
async function twinCodeAllowsUpload(orgId: string, user: { id: string; email: string }, code: string) {
  const access = await twinAccessByCode({ orgId, user, code, join: false }).catch(() => null);
  if (!access) return false;
  const agent = await db.agent.findFirst({ where: { id: access.agentId, orgId, kind: "TWIN" }, select: { data: true } });
  const settings = beforeSettings(agent?.data);
  return Boolean(agent) && (settings.preUpload || settings.duringUpload);
}

/**
 * Who may upload here: an enabled member of the org (role-play learners always are: specs/people.md), or someone
 * holding a twin share code for it (they join the org when their call starts). Null when neither.
 */
export async function uploader(shareCode: string | null | undefined) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return null;
  const member = await orgPerson(org.id, { userId: user.id });
  if (member && !member.disabled) return { org, user };
  if (member || typeof shareCode !== "string" || !shareCode) return null;
  return (await twinCodeAllowsUpload(org.id, user, shareCode)) ? { org, user } : null;
}
