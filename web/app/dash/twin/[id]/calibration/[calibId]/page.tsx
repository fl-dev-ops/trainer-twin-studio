"use client";

import { useParams } from "next/navigation";
import { CalibrationReview } from "@/components/calibration/calibration-review";
import { api, pageNotFound, useApi } from "@/lib/api";

export default function TwinCalibrationReviewRoute() {
  const { id, calibId } = useParams<{ id: string; calibId: string }>();
  const calibration = useApi(["twin.calibrations.get", calibId], () => api.twin.calibrations.get.query({ id: calibId }));
  if (calibration.slug !== id) pageNotFound();
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
