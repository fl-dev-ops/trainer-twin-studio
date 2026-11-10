import type { ComponentProps } from "react";
import type { OrgHome } from "@/components/org/org-home";
import { db } from "@/lib/db";
import { learnerBalance } from "@/lib/minutes";
import { parseHideRoleplay } from "@/lib/org";
import { isStudioMember, trainerProfile, twinAccessFor, twinProfile } from "@/lib/pages/learner";
import { resolveSessionUser } from "@/lib/session-user";
import { isAllSkillsTwin, twinSharePath } from "@/lib/twin-access";

/**
 * The org's home page (<org>.<base>/): public, so anyone can see what the org is and whose twins it has; signed in
 * (Google or an email code), a learner sees their minutes, the main twins with their access, and the role plays
 * assigned to them. Studio members (admin, team) see it as a preview.
 */

export type OrgHomeView = { kind: "notFound" } | { kind: "home"; props: ComponentProps<typeof OrgHome> };

const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

export async function loadOrgHome(): Promise<OrgHomeView> {
  const { org: found, user } = await resolveSessionUser();
  const org = found
    ? await db.organization.findUnique({ where: { id: found.id }, select: { id: true, slug: true, name: true, websiteUrl: true, metadata: true } })
    : null;
  if (!org) return { kind: "notFound" };

  const studio = user ? await isStudioMember(org.id, user.id) : false;

  // The main twins: each trainer's all-skills twin on their own persona (opened at /t/<username>). Their skill twins
  // are the topics the trainer covers ("What brings you to …"), as on a Delphi profile.
  const agents = await db.agent.findMany({
    where: { orgId: org.id, kind: "TWIN", archivedAt: null, persona: { isOwn: true } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, data: true, personaId: true },
  });
  const twins = await Promise.all(agents.filter((agent) => isAllSkillsTwin(agent.data)).map(async (agent) => {
    const [path, profile, access] = await Promise.all([
      twinSharePath(org.id, org.slug, agent.id),
      twinProfile(agent.id),
      twinAccessFor(org, user, agent.id, studio),
    ]);
    return {
      href: `/t/${encodeURIComponent(path)}`,
      ...profile,
      access,
      topics: agents
        .filter((skill) => skill.personaId === agent.personaId && !isAllSkillsTwin(skill.data))
        .map((skill) => ({ name: skill.name })),
    };
  }));

  // No main twin yet: still show who the org's trainer is (their own persona), just with nothing to start.
  const ownPersona = twins.length ? null : await db.persona.findFirst({ where: { orgId: org.id, isOwn: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const trainer = ownPersona ? await trainerProfile(ownPersona.id) : null;

  // A learner's role plays: assigned and not cancelled, practised or not (limited only by their minutes).
  const roleplays = user && !studio && !parseHideRoleplay(org.metadata)
    ? await db.rolePlayAssignment.findMany({
        where: {
          orgId: org.id,
          status: { in: ["pending", "used"] },
          member: { userId: user.id },
        },
        orderBy: { assignedAt: "desc" },
        select: { shareCode: true, expiresAt: true, deployment: { select: { agent: { select: { name: true, data: true } } } } },
      })
    : [];

  const minutesLeft = user && !studio ? Math.floor(Math.max(0, (await learnerBalance(org.id, user.email)).balanceSeconds) / 60) : null;
  return {
    kind: "home",
    props: {
      org: { name: org.name, websiteUrl: org.websiteUrl },
      viewer: user ? { name: user.name || user.email, email: user.email, studio, minutesLeft } : null,
      twins,
      trainer,
      roleplays: roleplays.map((row) => ({
        name: row.deployment.agent.name,
        description: text(record(row.deployment.agent.data).objective),
        href: `/s/${encodeURIComponent(row.shareCode)}`,
        expiresAt: row.expiresAt.toISOString(),
      })),
    },
  };
}
