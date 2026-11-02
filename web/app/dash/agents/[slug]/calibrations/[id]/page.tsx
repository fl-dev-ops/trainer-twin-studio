"use client";

import { useParams } from "next/navigation";
import { CalibrationReview } from "@/components/calibration/calibration-review";
import { DEMO_CALIBRATION } from "@/components/calibration/mock";
import { api, pageNotFound, useApi } from "@/lib/api";

export default function CalibrationPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  // shortcut: only the demo calibration exists until calibrations are stored.
  if (id !== DEMO_CALIBRATION.id) pageNotFound();
  return <DemoCalibration slug={slug} />;
}

function DemoCalibration({ slug }: { slug: string }) {
  const agent = useApi(["page.calibrationAgent", slug], () => api.page.calibrationAgent.query({ slug }));
  return (
    <CalibrationReview
      backHref={`/agents/${encodeURIComponent(agent.slug)}`}
      twinName={agent.twinName}
      startedAt={DEMO_CALIBRATION.startedAt}
      turns={DEMO_CALIBRATION.turns}
      score={{ turns: DEMO_CALIBRATION.turns.filter((turn) => turn.speaker === "you").length, off: 0 }}
    />
  );
}
