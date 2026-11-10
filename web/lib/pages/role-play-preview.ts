import { TRPCError } from "@trpc/server";
import type { OrganizationUser, RolePlayData } from "@/components/role-play-preview";
import { db } from "@/lib/db";
import { LEARNER, orgPeople } from "@/lib/org-people";
import { readSpecDraft } from "@/lib/spec-drafts";
import { agentDisplayName, readSpec } from "@/lib/specs";

/** /agents/<slug>: the role play (published or draft), the org's learners, and who it's assigned to. */
export async function loadRolePlayPreview(orgId: string, slug: string) {
  const [current, draft, members, assignments] = await Promise.all([
    readSpec("agents", slug, orgId).catch(() => null),
    readSpecDraft(slug, orgId).catch(() => null),
    orgPeople(orgId, { roles: [LEARNER] }),
    db.rolePlayAssignment.findMany({
      where: { orgId, deployment: { agent: { slug } } },
      orderBy: { assignedAt: "desc" },
      select: {
        id: true,
        status: true,
        assignedAt: true,
        expiresAt: true,
        member: { select: { user: { select: { name: true, email: true } } } },
      },
    }),
  ]);

  const assignmentSummaries = assignments.map(({ id, status, assignedAt, expiresAt, member }) => ({
    id,
    status,
    assignedAt: assignedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    userName: member.user.name || member.user.email,
    userEmail: member.user.email.toLowerCase(),
  }));

  const availableUsers: OrganizationUser[] = members.map((member) => ({
    id: member.memberId,
    name: member.name,
    email: member.email,
  }));

  let rolePlay: RolePlayData;

  if (current) {
    const doc = current.doc as Record<string, unknown>;
    const rawStages = Array.isArray(doc.stages) ? doc.stages : [];
    const config = (typeof doc.config === "object" && doc.config !== null
      ? doc.config
      : {}) as RolePlayData["config"];

    let voiceName: string | undefined;
    if (typeof doc.voiceId === "string" && doc.voiceId) {
      const voice = await db.voice.findFirst({
        where: { id: doc.voiceId, OR: [{ orgId }, { orgId: null }] },
        select: { name: true },
      });
      voiceName = voice?.name;
    }

    let knowledgeBaseName: string | undefined;
    if (typeof doc.knowledgeBase === "string" && doc.knowledgeBase) {
      const kb = await db.knowledgeBase.findFirst({
        where: { slug: doc.knowledgeBase, orgId },
        select: { name: true },
      });
      knowledgeBaseName = kb?.name;
    }

    rolePlay = {
      slug,
      name: agentDisplayName(slug, typeof doc.name === "string" ? doc.name : slug),
      objective: typeof doc.objective === "string" ? doc.objective : undefined,
      instruction: typeof doc.instruction === "string" ? doc.instruction : undefined,
      opening: typeof doc.opening === "string" ? doc.opening : undefined,
      voiceId: typeof doc.voiceId === "string" ? doc.voiceId : undefined,
      voiceName,
      knowledgeBase:
        typeof doc.knowledgeBase === "string" ? doc.knowledgeBase : undefined,
      knowledgeBaseName,
      status: "published",
      version: current.version,
      draftRevision: draft?.status === "draft" ? draft.revision : undefined,
      stages: rawStages as RolePlayData["stages"],
      config,
    };
  } else {
    if (!draft) throw new TRPCError({ code: "NOT_FOUND" });

    const agent = draft.agent as Record<string, unknown>;
    const rawStages = Array.isArray(agent?.stages) ? agent.stages : [];

    rolePlay = {
      slug: draft.slug,
      name: agentDisplayName(draft.slug, draft.name),
      objective: typeof agent?.objective === "string" ? agent.objective : undefined,
      instruction: typeof agent?.instruction === "string" ? agent.instruction : undefined,
      opening: typeof agent?.opening === "string" ? agent.opening : undefined,
      status: "draft",
      version: draft.revision,
      stages: rawStages as RolePlayData["stages"],
      config: (typeof agent?.config === "object" && agent?.config !== null
        ? agent.config
        : {}) as RolePlayData["config"],
    };
  }

  return { rolePlay, availableUsers, assignments: assignmentSummaries };
}
