"use client";

import { useParams } from "next/navigation";
import { TwinCalibrationOverviewPage } from "@/components/twin/twin-calibration-overview-page";
import { api, useApi } from "@/lib/api";

export default function TwinCalibrationOverviewRoute() {
  const { id } = useParams<{ id: string }>();
  const data = useApi(["twin.calibrations.list", id], () => api.twin.calibrations.list.query({ slug: id }));
  return <TwinCalibrationOverviewPage id={id} data={data} />;
}
