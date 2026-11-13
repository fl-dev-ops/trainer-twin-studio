import { start } from "workflow/api";
import { db } from "@/lib/db";
import { recordSessionUsage } from "@/lib/minutes";
import { closeSessionRoom } from "@/lib/session-close";
import { endRoleplaySession } from "@/workflows/end-roleplay-session";
import { endTwinSession } from "@/workflows/end-twin-session";

/**
 * After a call ends (its row already says completed or abandoned: lib/session-lifecycle.ts), the rest runs in its
 * kind's workflow: end-twin-session or end-roleplay-session (close the room, charge the call, the report). Each step
 * is safe to repeat. When a workflow can't start, the room is closed and the call charged right here (no report).
 */

export type SessionEndKind = "twin" | "roleplay";

/**
 * Starts the session's end workflow (twin or role play) and notes when (`endWorkAt`). Never throws at the person
 * ending the call: when it can't start, the room is closed here and `endWorkAt` stays empty, so the sweep starts it
 * again later (specs/practice.md rule 24).
 */
export async function startSessionEnd(sessionId: string) {
  try {
    const session = await db.interviewSession.findUnique({ where: { id: sessionId }, select: { agent: { select: { kind: true } } } });
    if (!session) return;
    await start(session.agent.kind === "TWIN" ? endTwinSession : endRoleplaySession, [sessionId]);
    await db.interviewSession.update({ where: { id: sessionId }, data: { endWorkAt: new Date() } });
  } catch (error) {
    console.error(`[session-end] ${sessionId}: workflow did not start; closing and charging here:`, error instanceof Error ? error.message : error);
    // The call has ended either way: a failure here is logged, never thrown at the person ending it.
    await closeSessionRoom(sessionId).catch((closeError: unknown) => console.error(`[session-end] ${sessionId}: closing the room failed:`, closeError));
    await recordSessionUsage(sessionId).catch((chargeError: unknown) => console.error(`[session-end] ${sessionId}: charging the call failed:`, chargeError));
  }
}
