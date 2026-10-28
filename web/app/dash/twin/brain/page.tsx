import { redirect } from "next/navigation";
import { TwinBrainPage, type BrainKnowledge } from "@/components/twin/twin-brain-page";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { avatarState } from "@/lib/twin/avatar";

export const dynamic = "force-dynamic";

/** Twin's brain. Knowledge (connectors + recent uploads) and voice/avatar are real; coaching style is fixed text for now. */
export default async function TwinBrainRoute() {
  const org = await getTrainerOrg();
  if (!org) redirect("/auth/no-org");
  const docs = { kb: { orgId: org.id } };
  const [notion, youtube, driveFiles, total, recent, avatar] = await Promise.all([
    db.notionConnection.findMany({ where: { orgId: org.id }, select: { id: true, workspaceName: true } }),
    db.youTubeConnection.findMany({ where: { orgId: org.id, status: "active" }, select: { id: true, channelTitle: true } }),
    // Drive has no saved connection (one-hour import sessions), so show what was imported from it.
    db.knowledgeDocument.count({ where: { ...docs, externalId: { startsWith: "google-drive:" } } }),
    db.knowledgeDocument.count({ where: docs }),
    db.knowledgeDocument.findMany({ where: docs, orderBy: { createdAt: "desc" }, take: 4, select: { id: true, title: true, slug: true } }),
    avatarState(org.id),
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
  return <TwinBrainPage knowledge={knowledge} avatar={avatar} />;
}
