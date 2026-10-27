import { notFound } from "next/navigation";
import { CalibrationReview } from "@/components/calibration/calibration-review";
import { DEMO_CALIBRATION } from "@/components/calibration/mock";
import { calibrationAgent } from "../../calibration-agent";

export const dynamic = "force-dynamic";

export default async function CalibrationPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  // shortcut: only the demo calibration exists until calibrations are stored.
  if (id !== DEMO_CALIBRATION.id) notFound();
  const agent = await calibrationAgent(slug);
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
