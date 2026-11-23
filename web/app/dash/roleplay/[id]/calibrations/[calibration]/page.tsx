"use client";

import { useParams } from "next/navigation";
import { CalibrationReview } from "@/components/calibration/calibration-review";
import { DEMO_CALIBRATION } from "@/components/calibration/mock";
import { api, pageNotFound, useApi } from "@/lib/api";
import { dashRoute } from "@/lib/routes";

export default function RoleplayCalibrationPage() {
  const { id, calibration } = useParams<{ id: string; calibration: string }>();
  // shortcut: only the demo calibration exists until role-play calibrations are stored.
  if (calibration !== DEMO_CALIBRATION.id) pageNotFound();
  return <DemoCalibration slug={id} />;
}

function DemoCalibration({ slug }: { slug: string }) {
  const agent = useApi(["page.calibrationAgent", slug], () => api.page.calibrationAgent.query({ slug }));
  return (
    <CalibrationReview
      backHref={dashRoute(`/roleplay/${encodeURIComponent(agent.slug)}`)}
      twinName={agent.twinName}
      startedAt={DEMO_CALIBRATION.startedAt}
      turns={DEMO_CALIBRATION.turns}
      score={{ turns: DEMO_CALIBRATION.turns.filter((turn) => turn.speaker === "you").length, off: 0 }}
    />
  );
}
