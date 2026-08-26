import { redirect } from "next/navigation";
import { SessionView } from "@/components/session-view";
import { getSessionOrg } from "@/lib/org";
import { listRunnableSpecs, listUploads } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function TalkPage() {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  const [personas, agents, contexts] = await Promise.all([
    listRunnableSpecs("personas", org.id),
    listRunnableSpecs("agents", org.id),
    listUploads(org.id),
  ]);
  return (
    <SessionView
      personas={personas}
      agents={agents}
      contexts={contexts.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
