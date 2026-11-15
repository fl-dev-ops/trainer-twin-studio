import { errorResponse } from "@/lib/errors";
import { practiceRefusals } from "@/lib/practice";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeBrowserSession } from "@/lib/interview-sessions";
import { z } from "zod";

export const dynamic = "force-dynamic";

const input = z.object({
  active: z.enum(["code", "canvas", "pdf", "image", "presentation", "choice"]).nullable(),
  key: z.string().max(120).nullable().optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

type UiState = {
  active: string | null;
  key?: string | null;
  updatedAt: string;
  revision: number;
};

/**
 * Candidate-side report of what is currently on screen. Written by the browser
 * whenever a workspace surface opens or closes; read by /api/copilot/studio
 * getSessionContext so the agent brain sees ground truth instead of guessing.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeBrowserSession(id, token);
  if (!session || session.id !== id) {
    return errorResponse(practiceRefusals.runtimeTokenInvalid());
  }

  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { active, key = null, revision } = parsed.data;
  const uiState: UiState = { active, key, revision, updatedAt: new Date().toISOString() };
  // Patch only this field. A delayed request must not overwrite a newer surface or unrelated runtime state.
  const applied = await db.$executeRaw`
    UPDATE "InterviewSession"
    SET "runtimeState" = jsonb_set(COALESCE("runtimeState", '{}'::jsonb), '{uiState}', ${JSON.stringify(uiState)}::jsonb)
    WHERE id = ${session.id} AND status IN ('activating', 'active')
      AND COALESCE(("runtimeState"->'uiState'->>'revision')::numeric, -1) <= ${revision}
  `;
  return NextResponse.json({ ok: true, applied: applied > 0, uiState });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeBrowserSession(id, token);
  if (!session || session.id !== id) {
    return errorResponse(practiceRefusals.runtimeTokenInvalid());
  }
  const runtimeState = (session.runtimeState ?? {}) as Record<string, unknown>;
  return NextResponse.json({ uiState: runtimeState.uiState ?? null });
}
