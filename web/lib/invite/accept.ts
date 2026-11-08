import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { LEARNER_ROLE } from "@/lib/org";

/**
 * The org home (<org>.<base>/) after Google sign-in: someone with a pending, unexpired learner invitation to this org
 * joins it (Better Auth accepts it and checks the signed-in email matches). Returns whether they joined just now; an
 * existing member, or nobody invited, is left as is.
 */
export async function acceptLearnerInvite(input: { orgId: string; user: { id: string; email: string }; headers: Headers }) {
  const member = await db.member.findFirst({ where: { organizationId: input.orgId, userId: input.user.id }, select: { id: true } });
  if (member) return false;
  const invitation = await db.invitation.findFirst({
    where: {
      organizationId: input.orgId,
      role: LEARNER_ROLE,
      status: "pending",
      expiresAt: { gt: new Date() },
      email: { equals: input.user.email, mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!invitation) return false;
  try {
    await auth.api.acceptInvitation({ headers: input.headers, body: { invitationId: invitation.id } });
    return true;
  } catch (error) {
    // The page still loads; they show as not joined and can ask their trainer.
    console.error("[invite] accepting a learner invitation failed", error instanceof Error ? error.message : error);
    return false;
  }
}
