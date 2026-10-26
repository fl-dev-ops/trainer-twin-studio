import { TwinEditPage } from "@/components/twin/twin-edit-page";
import { DEFAULT_TWIN_MINUTES } from "@/lib/twin-access";
import { orNotFound, twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinConfigureRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const twin = await twinServer();
  const [agent, learners] = await Promise.all([
    orNotFound(twin.agents.get({ slug: id })),
    orNotFound(twin.assignments.list({ slug: id })),
  ]);
  return <TwinEditPage twin={agent} learners={learners} defaultMinutes={DEFAULT_TWIN_MINUTES} defaultTab="learners" />;
}
