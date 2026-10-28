import { notFound } from "next/navigation";
import { CalibrationReview } from "@/components/calibration/calibration-review";
import { orNotFound, twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

export default async function TwinCalibrationReviewRoute({ params }: { params: Promise<{ id: string; calibId: string }> }) {
  const { id, calibId } = await params;
  const twin = await twinServer();
  const calibration = await orNotFound(twin.calibrations.get({ id: calibId }));
  if (calibration.slug !== id) notFound();
  return (
    <CalibrationReview
      backHref={`/twin/${id}/calibration`}
      twinName={calibration.twinName}
      photoUrl={calibration.photoUrl}
      startedAt={calibration.startedAt}
      turns={calibration.turns}
      score={calibration.score}
      sessionId={calibration.sessionId}
    />
  );
}
