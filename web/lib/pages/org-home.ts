import { headers } from "next/headers";
import type { ComponentProps } from "react";
import type { OrgHome } from "@/components/org/org-home";
import { db } from "@/lib/db";
import { acceptLearnerInvite } from "@/lib/invite/accept";
import { learnerBalance } from "@/lib/minutes";
import { parseHideRoleplay } from "@/lib/org";
import { isStudioMember, twinAccessFor, twinProfile } from "@/lib/pages/learner";
import { resolveSessionUser } from "@/lib/session-user";
import { isAllSkillsTwin, twinSharePath } from "@/lib/twin-access";

/**
 * The org's home page (<org>.<base>/): public, so anyone can see what the org is and whose twins it has; signed in
 * (Google), a learner's pending invite is accepted and they see their minutes, the main twins with their access, and
 * the role plays assigned to them. Studio members (admin, team) see it as a preview.
 */

export type OrgHomeView = { kind: "notFound" } | { kind: "home"; props: ComponentProps<typeof OrgHome> };

const dataImage = (logo: string | null) => (/^data:image\/(?:png|jpeg|webp);base64,/.test(logo ?? "") ? logo : null);

export async function loadOrgHome(): Promise<OrgHomeView> {
  const { org: found, user } = await resolveSessionUser();
  const org = found
    ? await db.organization.findUnique({ where: { id: found.id }, select: { id: true, slug: true, name: true, logo: true, websiteUrl: true, metadata: true } })
    : null;
  if (!org) return { kind: "notFound" };

  if (user) await acceptLearnerInvite({ orgId: org.id, user, headers: await headers() });
  const studio = user ? await isStudioMember(org.id, user.id) : false;

  // The main twins: each trainer's all-skills twin on their own persona (opened at /t/<username>).
  const agents = await db.agent.findMany({
    where: { orgId: org.id, kind: "TWIN", archivedAt: null, persona: { isOwn: true } },
    orderBy: { createdAt: "asc" },
    select: { id: true, data: true },
  });
  const twins = await Promise.all(agents.filter((agent) => isAllSkillsTwin(agent.data)).map(async (agent) => {
    const [path, profile, access] = await Promise.all([
      twinSharePath(org.id, org.slug, agent.id),
      twinProfile(agent.id),
      twinAccessFor(org, user, agent.id, studio),
    ]);
    return { href: `/t/${encodeURIComponent(path)}`, ...profile, access };
  }));

  // A learner's open role plays: still pending, not expired, not done (an ended session uses one up).
  const roleplays = user && !studio && !parseHideRoleplay(org.metadata)
    ? await db.rolePlayAssignment.findMany({
        where: {
          orgId: org.id,
          status: "pending",
          expiresAt: { gt: new Date() },
          sessions: { none: { status: { in: ["completed", "abandoned"] } } },
          OR: [{ member: { userId: user.id } }, { memberId: null, recipientEmail: user.email.toLowerCase() }],
        },
        orderBy: { assignedAt: "desc" },
        select: { shareCode: true, expiresAt: true, deployment: { select: { agent: { select: { name: true, data: true } } } } },
      })
    : [];

  const minutesLeft = user && !studio ? Math.floor(Math.max(0, (await learnerBalance(org.id, user.email)).balanceSeconds) / 60) : null;
  return {
    kind: "home",
    props: {
      org: { name: org.name, logo: dataImage(org.logo), websiteUrl: org.websiteUrl },
      viewer: user ? { name: user.name || user.email, email: user.email, studio, minutesLeft } : null,
      twins,
      roleplays: roleplays.map((row) => {
        const data = row.deployment.agent.data && typeof row.deployment.agent.data === "object" ? (row.deployment.agent.data as Record<string, unknown>) : {};
        return {
          name: row.deployment.agent.name,
          description: typeof data.objective === "string" && data.objective.trim() ? data.objective.trim() : null,
          href: `/s/${encodeURIComponent(row.shareCode)}`,
          expiresAt: row.expiresAt.toISOString(),
        };
      }),
    },
  };
}
