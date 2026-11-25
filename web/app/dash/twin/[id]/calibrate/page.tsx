"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { CalibrationCards } from "@/components/calibration/calibration-cards";
import { api, useApi } from "@/lib/api";

/** Calibrate, card by card in text (calibration v2); the voice call lives at `/calibrate/call`. */
export default function TwinCalibrateRoute() {
  const { id } = useParams<{ id: string }>();
  // An older "?mode=call" link goes to the call.
  const call = useSearchParams().get("mode") === "call";
  const router = useRouter();
  useEffect(() => {
    if (call) router.replace(`/twin/${encodeURIComponent(id)}/calibrate/call`);
  }, [call, id, router]);
  if (call) return null;
  return <Cards slug={id} />;
}

function Cards({ slug }: { slug: string }) {
  const agent = useApi(["twin.agents.get", slug], () => api.twin.agents.get.query({ slug }));
  // Attach on a question only when the twin takes files during a conversation, as on a call.
  return <CalibrationCards key={slug} slug={slug} attach={agent.settings.duringUpload} />;
}
