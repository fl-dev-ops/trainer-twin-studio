import { errorResponse } from "@/lib/errors";
import { practiceRefusals } from "@/lib/practice";
import { NextResponse } from "next/server";
import { authorizeBrowserSession } from "@/lib/interview-sessions";
import { claimWorkspaceCommand, completeWorkspaceCommand } from "@/lib/workspace-commands";
import { z } from "zod";

const message = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), consumerId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("complete"), consumerId: z.string().uuid(), status: z.enum(["completed", "failed"]), result: z.unknown() }).strict(),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; callId: string }> },
) {
  const { id, callId } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await authorizeBrowserSession(id, token);
  if (!session || session.id !== id) return errorResponse(practiceRefusals.runtimeTokenInvalid());
  const parsed = message.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid workspace acknowledgement", code: "invalid_input" }, { status: 400 });
  const body = parsed.data;
  if (body.action === "claim") return NextResponse.json({ claimed: await claimWorkspaceCommand(id, callId, body.consumerId) });
  const ok = await completeWorkspaceCommand(id, callId, body.consumerId, body.result, body.status === "failed");
  return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
}
