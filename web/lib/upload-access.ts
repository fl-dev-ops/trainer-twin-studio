import { assignmentMatchesUser } from "@/lib/assignments";
import { beforeSettings } from "@/lib/context-upload";
import { db } from "@/lib/db";
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
 * Who may upload here: a member of the org, or someone holding a role-play invite or twin code for it (a learner
 * before they join). Null when neither.
 */
export async function uploader(shareCode: string | null | undefined) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return null;
  const member = await db.member.findFirst({ where: { organizationId: org.id, userId: user.id }, select: { id: true } });
  if (member) return { org, user };
  if (typeof shareCode !== "string" || !shareCode) return null;
  const assignment = await db.rolePlayAssignment.findFirst({
    where: { shareCode, orgId: org.id, status: "pending", expiresAt: { gt: new Date() }, deployment: { status: "active" } },
    select: {
      recipientEmail: true,
      member: { select: { userId: true } },
      sessions: { where: { status: { in: ["completed", "abandoned"] } }, select: { id: true }, take: 1 },
    },
  });
  if (assignment) return assignmentMatchesUser(assignment, user) && !assignment.sessions.length ? { org, user } : null;
  return (await twinCodeAllowsUpload(org.id, user, shareCode)) ? { org, user } : null;
}
