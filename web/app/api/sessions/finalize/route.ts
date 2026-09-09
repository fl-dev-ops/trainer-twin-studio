import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSessionUser } from "@/lib/session-user";
import { LearnerMemoryService } from "@/lib/learner-memory";

/**
 * Finalizes a session: persists the transcript and evidence coverage captured
 * by the browser before the user leaves the session page, and stamps identity.
 */
export async function POST(request: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body?.sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const transcript =
    Array.isArray(body.transcript) && body.transcript.length > 0
      ? body.transcript.filter(
          (e: unknown) =>
            typeof e === "object" && e !== null && typeof (e as { text?: unknown }).text === "string",
        )
      : undefined;
  const evidence =
    typeof body.evidence === "object" && body.evidence !== null && Object.keys(body.evidence).length > 0
      ? body.evidence
      : undefined;

  const existing = await db.interviewSession.findFirst({
    where: { id: String(body.sessionId), orgId: org.id, userId: user.id },
    select: { transcript: true, evidence: true },
  });
  if (!existing) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const hasCanonicalTranscript = Array.isArray(existing.transcript) && existing.transcript.length > 0;
  const hasCanonicalEvidence =
    existing.evidence && typeof existing.evidence === "object" && Object.keys(existing.evidence).length > 0;

  await db.interviewSession.update({
    where: { id: String(body.sessionId) },
    data: {
      ...(!hasCanonicalTranscript && transcript ? { transcript } : {}),
      ...(!hasCanonicalEvidence && evidence ? { evidence } : {}),
    },
  });

  const effectiveTranscript = (hasCanonicalTranscript ? existing.transcript : transcript) as
    | Array<{ speaker?: string; role?: string; text?: string }>
    | undefined;

  // Hook for learner collection creation & session turn memory
  try {
    // Lazily creates the org's learner_<userId> collection if not already present
    await LearnerMemoryService.getCollection(org.id, user.id);

    if (effectiveTranscript && effectiveTranscript.length > 0) {
      const learnerLines = effectiveTranscript
        .filter((entry) => (entry.speaker === "learner" || entry.role === "learner" || entry.role === "user") && typeof entry.text === "string")
        .map((entry) => entry.text!.trim())
        .filter(Boolean);

      if (learnerLines.length > 0) {
        LearnerMemoryService.addMemory(
          org.id,
          user.id,
          `session_${body.sessionId}`,
          learnerLines.join("\n"),
          { sessionId: body.sessionId, timestamp: new Date().toISOString() },
        ).catch((err) => {
          console.warn("Learner memory hook notice:", err);
        });
      }
    }
  } catch (err) {
    console.warn("Learner collection hook notice:", err);
  }

  return NextResponse.json({ ok: true });
}
