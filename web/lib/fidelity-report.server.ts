import "server-only";

import { fidelityReportSchema, type FidelityReport } from "@/lib/fidelity-report";
import { fidelityReportKey, getObjectText, s3Configured } from "@/lib/s3";

export async function loadLatestFidelityReport(orgId: string): Promise<FidelityReport | null> {
  if (!s3Configured) return null;
  try {
    return fidelityReportSchema.parse(JSON.parse(await getObjectText(fidelityReportKey(orgId))));
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return null;
    console.error("Could not load fidelity report", error);
    return null;
  }
}
