import { NextResponse } from "next/server";
import { z } from "zod";
import { createAgentLaunchToken } from "@/lib/agent-token";
import { resolveSessionUser } from "@/lib/session-user";
import { getAgentConfig, createSessionRecord } from "@/lib/specs";

const bodySchema = z.object({
  personaSlug: z.string().min(1),
  agentSlug: z.string().min(1),
  contextId: z.string().min(1).optional(),
});

/**
 * Learner-initiated session start (plan §2.6): resolves the org-scoped specs,
 * binds the InterviewSession to the learner identity, and mints a 5-minute
 * launch token the Pipecat agent verifies before attaching the identity.
 */
export async function POST(request: Request) {
  const { org, user } = await resolveSessionUser();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { personaSlug, agentSlug, contextId } = parsed.data;

  const config = await getAgentConfig(personaSlug, agentSlug, contextId);
  if (!config || config.persona.slug !== personaSlug || config.agent.slug !== agentSlug) {
    return NextResponse.json({ error: "Interview not found" }, { status: 404 });
  }

  const session = await createSessionRecord({
    orgId: org.id,
    userId: user.id,
    personaSlug: config.persona.slug,
    personaVersion: config.persona.version,
    agentSlug: config.agent.slug,
    agentVersion: config.agent.version,
    domainSlug: config.domain.slug,
    domainVersion: config.domain.version,
    contextName: config.context?.name,
  });

  const token = await createAgentLaunchToken({
    sessionId: session.id,
    userId: user.id,
    orgId: org.id,
    agentSlug: config.agent.slug,
    personaSlug: config.persona.slug,
    contextIds: contextId ? [contextId] : [],
  });

  return NextResponse.json({ session, token });
}
