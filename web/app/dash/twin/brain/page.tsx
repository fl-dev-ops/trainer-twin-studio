import { redirect } from "next/navigation";
import { TwinBrainPage, type BrainKnowledge } from "@/components/twin/twin-brain-page";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { avatarState } from "@/lib/twin/avatar";
import { TWIN_SOURCE } from "@/lib/twins";

export const dynamic = "force-dynamic";

/** Twin's brain. Knowledge is real (connectors + recent uploads); training style and voice are still mock UI. */
export default async function TwinBrainRoute() {
  const org = await getTrainerOrg();
  if (!org) redirect("/auth/no-org");
  const docs = { kb: { orgId: org.id } };
  const [notion, youtube, driveFiles, total, recent, avatar, skills] = await Promise.all([
    db.notionConnection.findMany({ where: { orgId: org.id }, select: { id: true, workspaceName: true } }),
    db.youTubeConnection.findMany({ where: { orgId: org.id, status: "active" }, select: { id: true, channelTitle: true } }),
    // Drive has no saved connection (one-hour import sessions), so show what was imported from it.
    db.knowledgeDocument.count({ where: { ...docs, externalId: { startsWith: "google-drive:" } } }),
    db.knowledgeDocument.count({ where: docs }),
    db.knowledgeDocument.findMany({ where: docs, orderBy: { createdAt: "desc" }, take: 4, select: { id: true, title: true, slug: true } }),
    avatarState(org.id),
    // Skill twins (not the all-skills twin): what the twin has learned, topic by topic.
    db.agent.findMany({
      where: { orgId: org.id, kind: "TWIN", NOT: { data: { path: ["source"], equals: TWIN_SOURCE } } },
      orderBy: { updatedAt: "desc" },
      take: 4,
      select: { slug: true, name: true },
    }),
  ]);
  const knowledge: BrainKnowledge = {
    connectors: [
      ...notion.map((c) => ({ id: c.id, kind: "notion" as const, label: c.workspaceName || "Notion", status: "Connected" })),
      ...youtube.map((c) => ({ id: c.id, kind: "youtube" as const, label: c.channelTitle || "YouTube", status: "Connected" })),
      ...(driveFiles ? [{ id: "google-drive", kind: "drive" as const, label: "Google Drive", status: `${driveFiles} imported` }] : []),
    ],
    recent: recent.map((d) => ({ id: d.id, title: d.title || d.slug })),
    total,
  };
  return <TwinBrainPage knowledge={knowledge} avatar={avatar} skills={skills} />;
}
