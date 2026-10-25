import { CalibrationCall } from "@/components/calibration/calibration-call";
import { calibrationAgent } from "../calibration-agent";

export const dynamic = "force-dynamic";

export default async function CalibratePage({ params }: { params: Promise<{ slug: string }> }) {
  return <CalibrationCall {...await calibrationAgent((await params).slug)} />;
}
