import { NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/specs";

/** Compiled spec + knowledge + context for the Pipecat voice agent. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const personaId = url.searchParams.get("persona");
  const agentId = url.searchParams.get("agent");
  const contextId = url.searchParams.get("context") ?? undefined;
  if (!personaId || !agentId) {
    return NextResponse.json({ error: "persona and agent are required" }, { status: 400 });
  }
  const config = await getAgentConfig(personaId, agentId, contextId);
  if (!config) return NextResponse.json({ error: "Spec not found" }, { status: 404 });
  return NextResponse.json(config, { headers: { "Cache-Control": "no-store" } });
}
