import { TwinCalibrationOverviewPage } from "@/components/twin/twin-calibration-overview-page";
import { orNotFound, twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinCalibrationOverviewRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const twin = await twinServer();
  return <TwinCalibrationOverviewPage id={id} data={await orNotFound(twin.calibrations.list({ slug: id }))} />;
}
