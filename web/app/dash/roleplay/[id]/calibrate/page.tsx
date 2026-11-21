"use client";

import { useParams } from "next/navigation";
import { CalibrationCall } from "@/components/calibration/calibration-call";
import { api, useApi } from "@/lib/api";

/** Calibrate a role play: a call with its persona, for checking how it sounds. */
export default function RoleplayCalibratePage() {
  const { id } = useParams<{ id: string }>();
  const agent = useApi(["page.calibrationAgent", id], () => api.page.calibrationAgent.query({ slug: id }));
  return <CalibrationCall {...agent} />;
}
