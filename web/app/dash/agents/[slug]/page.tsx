import { notFound, redirect } from "next/navigation";
import {
  RolePlayPreview,
  type OrganizationUser,
  type RolePlayData,
} from "@/components/role-play-preview";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { readSpecDraft } from "@/lib/spec-drafts";
import { readSpec } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function RolePlayPreviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");

  const [current, members] = await Promise.all([
    readSpec("agents", slug, org.id).catch(() => null),
    db.member.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  const availableUsers: OrganizationUser[] = members.map((m) => ({
    id: m.user.id || m.id,
    name: m.user.name || "Unnamed User",
    email: m.user.email,
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
      const voice = await db.voice.findUnique({
        where: { id: doc.voiceId },
        select: { name: true },
      });
      voiceName = voice?.name;
    }

    let knowledgeBaseName: string | undefined;
    if (typeof doc.knowledgeBase === "string" && doc.knowledgeBase) {
      const kb = await db.knowledgeBase.findUnique({
        where: { slug: doc.knowledgeBase },
        select: { name: true },
      });
      knowledgeBaseName = kb?.name;
    }

    rolePlay = {
      slug,
      name: typeof doc.name === "string" ? doc.name : slug,
      domainSlug: typeof doc.domain === "string" ? doc.domain : undefined,
      objective: typeof doc.objective === "string" ? doc.objective : undefined,
      opening: typeof doc.opening === "string" ? doc.opening : undefined,
      voiceId: typeof doc.voiceId === "string" ? doc.voiceId : undefined,
      voiceName,
      knowledgeBase:
        typeof doc.knowledgeBase === "string" ? doc.knowledgeBase : undefined,
      knowledgeBaseName,
      status: "published",
      version: current.version,
      stages: rawStages as RolePlayData["stages"],
      config,
    };
  } else {
    const draft = await readSpecDraft(slug).catch(() => null);
    if (!draft) notFound();

    const agent = draft.agent as Record<string, unknown>;
    const rawStages = Array.isArray(agent?.stages) ? agent.stages : [];

    rolePlay = {
      slug: draft.slug,
      name: draft.name,
      domainSlug:
        typeof draft.domain?.name === "string" ? draft.domain.name : undefined,
      objective: typeof agent?.objective === "string" ? agent.objective : undefined,
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
      orgSlug={org.slug}
      availableUsers={availableUsers}
      trainerName="Vasanth"
    />
  );
}
