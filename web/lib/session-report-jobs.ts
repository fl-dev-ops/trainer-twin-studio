import { after } from "next/server";
import { db } from "@/lib/db";
import { generateSessionReport } from "@/lib/generate-session-report";

export function isSessionReportEligible(status: string, reportStatus: string | null) {
  return status === "completed" && (!reportStatus || reportStatus === "none" || reportStatus === "failed");
}

export async function scheduleSessionReport(sessionId: string) {
  const claimed = await db.interviewSession.updateMany({
    where: {
      id: sessionId,
      status: "completed",
      OR: [
        { reportStatus: null },
        { reportStatus: "none" },
        { reportStatus: "failed" },
      ],
    },
    data: { reportStatus: "generating" },
  });
  if (claimed.count === 0) return false;

  try {
    after(async () => {
      await generateSessionReport(sessionId);
    });
    return true;
  } catch (error) {
    await db.interviewSession.updateMany({
      where: { id: sessionId, reportStatus: "generating" },
      data: { reportStatus: "failed" },
    });
    throw error;
  }
}
