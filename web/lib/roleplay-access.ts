import { db } from "@/lib/db";
import { deploymentAllowsMode, type DeliveryMode } from "@/lib/deployments";
import { AppError, refusals } from "@/lib/errors";
import { practicePerson } from "@/lib/practice";

/** A role-play access refusal (specs/practice.md Refusals). */
export class RoleplayAccessError extends AppError {}

export const roleplayRefusals = {
  notAssigned: () => new RoleplayAccessError("roleplay_not_assigned", "This role play isn't assigned to you.", 403),
  accessRemoved: () => new RoleplayAccessError("roleplay_access_removed", "Your access to this role play was removed. Ask your trainer.", 403),
  modeNotAllowed: (mode: DeliveryMode) => new RoleplayAccessError("mode_not_allowed", `This role play can't be started as ${mode}.`, 400),
};

/**
 * What a /s/<code> is for role plays (specs/practice.md rule 17), checked in the order the link page and Start share:
 * null when the code isn't a role-play link of this org; else the person (an enabled member), the link (theirs,
 * still open) and its live role play, plus the mode when one is asked for. Pause and credits come next
 * (startAllowance). Refusals: no_org, member_disabled, roleplay_not_assigned, roleplay_access_removed, not_found,
 * mode_not_allowed.
 */
export async function roleplayAccessByCode(input: { orgId: string; userId: string; code: string; mode?: DeliveryMode }) {
  const link = await db.rolePlayAssignment.findFirst({
    where: { shareCode: input.code, orgId: input.orgId },
    select: {
      id: true,
      status: true,
      member: { select: { userId: true } },
      deployment: { select: { id: true, status: true, allowedModes: true, agent: { select: { id: true, slug: true, archivedAt: true } } } },
    },
  });
  if (!link) return null;
  const person = await practicePerson(input.orgId, input.userId);
  if (link.member.userId !== input.userId) throw roleplayRefusals.notAssigned();
  if (!["pending", "used"].includes(link.status)) throw roleplayRefusals.accessRemoved();
  if (link.deployment.agent.archivedAt || link.deployment.status !== "active") throw refusals.notFound();
  if (input.mode && (!deploymentAllowsMode(link.deployment.allowedModes, input.mode) || input.mode !== "voice")) {
    throw roleplayRefusals.modeNotAllowed(input.mode);
  }
  return { person, assignmentId: link.id, deploymentId: link.deployment.id, agentId: link.deployment.agent.id, agentSlug: link.deployment.agent.slug };
}

/** A link that can be removed (dashboard and API alike): still pending and nobody has practised on it (rule 19). */
export const removableLink = { status: "pending", sessions: { none: {} } } as const;
