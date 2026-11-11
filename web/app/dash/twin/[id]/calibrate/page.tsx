"use client";

import { useParams } from "next/navigation";
import { CalibrationCall } from "@/components/calibration/calibration-call";
import { api, useApi } from "@/lib/api";

export default function TwinLiveCalibrateRoute() {
  const { id } = useParams<{ id: string }>();
  const [{ name, face, blocked }, agent] = useApi(["twin.calibrate", id], () =>
    Promise.all([api.twin.calibrations.list.query({ slug: id }), api.twin.agents.get.query({ slug: id })]),
  );
  // The trainer rehearses what learners get: Attach shows only when the twin allows images during the call.
  return <CalibrationCall slug={id} scenarioName={name} twinName={name} photoUrl={face.avatarUrl} twin attach={agent.settings.duringUpload} blocked={blocked} />;
}
