import { TwinCalibrationOverviewPage } from "@/components/twin/twin-calibration-overview-page";

export default async function TwinCalibrationOverviewRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TwinCalibrationOverviewPage id={id} />;
}
