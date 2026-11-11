import { errorResponse, refusals } from "@/lib/errors";
import { after, NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { practicePerson } from "@/lib/practice";

const MAX_BODY_BYTES = 1024 * 1024;
const tooBig = () => new AppError("invalid_input", "This call's end is too big to save (over 1 MB).", 400);
import { db } from "@/lib/db";
import { type SessionEndStatus } from "@/lib/interview-sessions";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { Prisma } from "@/lib/generated/prisma/client";
import { resolveSessionUser } from "@/lib/session-user";
import { LearnerMemoryService } from "@/lib/learner-memory";

/**
 * Finalizes a session: persists the transcript and evidence coverage captured
 * by the browser before the user leaves the session page, and stamps identity.
 */
export async function POST(request: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org || !user) return errorResponse(refusals.signedOut());

  // At most 1 MB (practice rule 22): refused from its declared size, then from what arrived.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return errorResponse(tooBig());
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return errorResponse(tooBig());
  const body = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (!body?.sessionId) return errorResponse(refusals.invalidInput("Missing sessionId"));
  if (!["completed", "abandoned"].includes(body.status)) return errorResponse(refusals.invalidInput("Invalid session status"));
  // The call's owner, while an enabled member of its org.
  const person = await practicePerson(org.id, user.id).catch((error: unknown) => errorResponse(error));
  if (person instanceof Response) return person;
  const requestedStatus = body.status as SessionEndStatus;

  const transcript =
    Array.isArray(body.transcript) && body.transcript.length > 0
      ? body.transcript.filter(
          (e: unknown) =>
            typeof e === "object" && e !== null && typeof (e as { text?: unknown }).text === "string",
        )
      : undefined;
  // The page never sets evidence (recording keys, "transcript final"): only the agent and the server do (rule 22).

  const existing = await db.interviewSession.findFirst({
    where: { id: String(body.sessionId), orgId: org.id, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!existing) return errorResponse(refusals.notFound());

  const finalized = await closeInterviewSession(existing.id, requestedStatus, {
    transcript: transcript as Prisma.InputJsonValue | undefined,
  });
  if (!finalized) return errorResponse(refusals.notFound());

  const effectiveTranscript = finalized.transcript as
    | Array<{ speaker?: string; role?: string; text?: string }>
    | undefined;

  // Learner memory after the reply (the page may be closing): nothing waits on it.
  after(async () => {
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
  });

  // The report (completed sessions, abandoned twin learner calls where the learner spoke) runs in the session's end
  // workflow, started by closeInterviewSession.
  return NextResponse.json({ ok: true });
}
