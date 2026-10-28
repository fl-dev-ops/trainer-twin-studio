import { CalibrationCall } from "@/components/calibration/calibration-call";
import { DEFAULT_CONTEXT_ACCEPT } from "@/lib/context-upload";
import { orNotFound, twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinLiveCalibrateRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const twin = await twinServer();
  const [{ name, face }, agent] = await Promise.all([
    orNotFound(twin.calibrations.list({ slug: id })),
    orNotFound(twin.agents.get({ slug: id })),
  ]);
  // The trainer rehearses what learners get: Attach shows only when the twin allows files during the call.
  const attach = agent.settings.duringUpload ? { accept: DEFAULT_CONTEXT_ACCEPT } : undefined;
  return <CalibrationCall slug={id} scenarioName={name} twinName={name} photoUrl={face.avatarUrl} twin attach={attach} />;
}
