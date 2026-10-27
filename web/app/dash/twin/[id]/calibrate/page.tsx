import { CalibrationCall } from "@/components/calibration/calibration-call";
import { orNotFound, twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinLiveCalibrateRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const twin = await twinServer();
  const { name, face } = await orNotFound(twin.calibrations.list({ slug: id }));
  return <CalibrationCall slug={id} scenarioName={name} twinName={name} photoUrl={face.avatarUrl} twin />;
}
