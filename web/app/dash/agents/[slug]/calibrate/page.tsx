"use client";

import { useParams } from "next/navigation";
import { CalibrationCall } from "@/components/calibration/calibration-call";
import { api, useApi } from "@/lib/api";

export default function CalibratePage() {
  const { slug } = useParams<{ slug: string }>();
  const agent = useApi(["page.calibrationAgent", slug], () => api.page.calibrationAgent.query({ slug }));
  return <CalibrationCall {...agent} />;
}
