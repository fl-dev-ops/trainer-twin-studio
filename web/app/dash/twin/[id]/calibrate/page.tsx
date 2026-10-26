import { CalibrationCall } from "@/components/calibration/calibration-call";

export default async function TwinLiveCalibrateRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const twinName = id === "olga-twin" ? "Olga’s twin" : "The off-plan sales process";

  return (
    <CalibrationCall
      slug={id}
      scenarioName={twinName}
      twinName={twinName}
    />
  );
}
