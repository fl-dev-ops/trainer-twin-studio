"use client";

import { useParams } from "next/navigation";
import { CalibrationCall } from "@/components/calibration/calibration-call";
import { api, useApi } from "@/lib/api";
import { DEFAULT_CONTEXT_ACCEPT } from "@/lib/context-upload";

export default function TwinLiveCalibrateRoute() {
  const { id } = useParams<{ id: string }>();
  const [{ name, face }, agent] = useApi(["twin.calibrate", id], () =>
    Promise.all([api.twin.calibrations.list.query({ slug: id }), api.twin.agents.get.query({ slug: id })]),
  );
  // The trainer rehearses what learners get: Attach shows only when the twin allows files during the call.
  const attach = agent.settings.duringUpload ? { accept: DEFAULT_CONTEXT_ACCEPT } : undefined;
  return <CalibrationCall slug={id} scenarioName={name} twinName={name} photoUrl={face.avatarUrl} twin attach={attach} />;
}
