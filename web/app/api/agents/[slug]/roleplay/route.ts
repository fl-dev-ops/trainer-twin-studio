import { z } from "zod";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { buildRoleplayBundle, isClientPersonaData, roleplayInputSchema } from "@/lib/roleplay";
import { publishSpecDraft, readSpecDraft, saveSpecDraft } from "@/lib/spec-drafts";
import { validSlug } from "@/lib/specs";

export const runtime = "nodejs";

const requestSchema = roleplayInputSchema.extend({ publish: z.boolean().optional() });

const GENERIC_SAVE_ERROR = "Failed to save the change, try again in a few seconds";

/**
 * Saves a client role-play scenario. Unlike Twin scenarios, the spec is built
 * deterministically from the builder fields (no LLM), then goes through the same
 * draft → publish → versioning flow.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await getTrainerOrg();
  if (!org) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { slug: agentSlug } = await params;
  if (!validSlug(agentSlug)) return Response.json({ error: "Invalid scenario id" }, { status: 400 });

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { publish, ...input } = parsed.data;

  const persona = await db.persona.findUnique({
    where: { orgId_slug: { orgId: org.id, slug: input.persona } },
    select: { data: true },
  });
  if (!persona || !isClientPersonaData(persona.data)) {
    return Response.json({ error: "Choose who the learner will speak with" }, { status: 400 });
  }

  // The scenario speaks with the chosen voice, else the persona's own voice.
  const personaVoice = (persona.data as { voiceId?: unknown }).voiceId;
  const voiceId = input.voiceId || (typeof personaVoice === "string" ? personaVoice : undefined);
  if (voiceId) {
    const voice = await db.voice.findFirst({
      where: { id: voiceId, status: "ready", OR: [{ orgId: org.id }, { orgId: null }] },
      select: { id: true },
    });
    if (!voice && input.voiceId) return Response.json({ error: "Voice is not available" }, { status: 400 });
    input.voiceId = voice ? voiceId : undefined;
  }

  try {
    const published = await db.agent.findFirst({ where: { slug: agentSlug, orgId: org.id } });
    const publishedDomain = published
      ? await db.domain.findFirst({ where: { slug: published.domainSlug, orgId: org.id }, select: { version: true } })
      : null;

    const bundle = buildRoleplayBundle(input, {
      slug: agentSlug,
      agentVersion: published?.version ?? 1,
      // Keep the published domain id so versions stay comparable.
      domainId: published?.domainSlug ?? `domain-${agentSlug}`,
      domainVersion: publishedDomain?.version ?? 1,
    });

    await saveSpecDraft(bundle, org.id);
    const publication = publish ? await publishSpecDraft(agentSlug, org.id) : null;
    const saved = await readSpecDraft(agentSlug, org.id);
    return Response.json({
      status: publish ? "published" : "draft",
      revision: saved?.revision ?? 1,
      agentVersion: publication?.agentVersion,
      domainVersion: publication?.domainVersion,
      agent: publication ? { ...bundle.agent, version: publication.agentVersion } : bundle.agent,
      domain: publication ? { ...bundle.domain, version: publication.domainVersion } : bundle.domain,
    });
  } catch (error) {
    console.error("Role-play save failed", error);
    return Response.json({ error: GENERIC_SAVE_ERROR }, { status: 500 });
  }
}
