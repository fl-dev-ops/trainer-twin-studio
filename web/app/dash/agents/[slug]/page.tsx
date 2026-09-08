import { notFound, redirect } from "next/navigation";
import {
  RolePlayPreview,
  type OrganizationUser,
  type RolePlayData,
} from "@/components/role-play-preview";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { readSpecDraft } from "@/lib/spec-drafts";
import { readSpec } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function RolePlayPreviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const org = await getTrainerOrg();
  if (!org) redirect("/auth/no-org");

  const [current, draft, members, assignments] = await Promise.all([
    readSpec("agents", slug, org.id).catch(() => null),
    readSpecDraft(slug, org.id).catch(() => null),
    db.member.findMany({
      where: { organizationId: org.id, role: "member" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        user: { select: { name: true, email: true } },
      },
    }),
    db.rolePlayAssignment.findMany({
      where: { orgId: org.id, agent: { slug } },
      select: { memberId: true },
    }),
  ]);

  const availableUsers: OrganizationUser[] = members.map((member) => ({
    id: member.id,
    name: member.user.name || "Unnamed User",
    email: member.user.email,
  }));

  let rolePlay: RolePlayData | null = null;

  if (current) {
    const doc = current.doc as Record<string, unknown>;
    const rawStages = Array.isArray(doc.stages) ? doc.stages : [];
    const config = (typeof doc.config === "object" && doc.config !== null
      ? doc.config
      : {}) as RolePlayData["config"];

    let voiceName: string | undefined;
    if (typeof doc.voiceId === "string" && doc.voiceId) {
      const voice = await db.voice.findFirst({
        where: { id: doc.voiceId, OR: [{ orgId: org.id }, { orgId: null }] },
        select: { name: true },
      });
      voiceName = voice?.name;
    }

    let knowledgeBaseName: string | undefined;
    if (typeof doc.knowledgeBase === "string" && doc.knowledgeBase) {
      const kb = await db.knowledgeBase.findFirst({
        where: { slug: doc.knowledgeBase, orgId: org.id },
        select: { name: true },
      });
      knowledgeBaseName = kb?.name;
    }

    rolePlay = {
      slug,
      name: typeof doc.name === "string" ? doc.name : slug,
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
    if (!draft) notFound();

    const agent = draft.agent as Record<string, unknown>;
    const rawStages = Array.isArray(agent?.stages) ? agent.stages : [];

    rolePlay = {
      slug: draft.slug,
      name: draft.name,
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

  return (
    <RolePlayPreview
      rolePlay={rolePlay}
      availableUsers={availableUsers}
      assignedUserIds={assignments.map(({ memberId }) => memberId)}
    />
  );
}
