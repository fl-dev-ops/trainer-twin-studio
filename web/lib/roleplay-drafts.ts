import { db } from "@/lib/db";
import { buildRoleplayBundle, isClientPersonaData, type RoleplayInput } from "@/lib/roleplay";
import type { SpecDraftBundle } from "@/lib/spec-draft-schema";

/** A role-play input the trainer has to fix (unknown client persona, unavailable voice). */
export class RoleplayInputError extends Error {}

/**
 * Builds the draft bundle for a role play from validated builder fields: checks the
 * client persona and voice, and keeps the published domain id and versions so a
 * re-save stays comparable. Used by the role-play builder and the Copilot.
 */
export async function roleplayDraftBundle(orgId: string, agentSlug: string, input: RoleplayInput): Promise<SpecDraftBundle> {
  const persona = await db.persona.findUnique({
    where: { orgId_slug: { orgId, slug: input.persona } },
    select: { data: true },
  });
  if (!persona || !isClientPersonaData(persona.data)) {
    throw new RoleplayInputError("Choose who the learner will speak with");
  }

  // The role play speaks with the chosen voice, else the persona's own voice.
  const personaVoice = (persona.data as { voiceId?: unknown }).voiceId;
  const voiceId = input.voiceId || (typeof personaVoice === "string" ? personaVoice : undefined);
  let resolvedVoice: string | undefined;
  if (voiceId) {
    const voice = await db.voice.findFirst({
      where: { id: voiceId, status: "ready", OR: [{ orgId }, { orgId: null }] },
      select: { id: true },
    });
    if (!voice && input.voiceId) throw new RoleplayInputError("Voice is not available");
    resolvedVoice = voice ? voiceId : undefined;
  }

  const published = await db.agent.findFirst({ where: { slug: agentSlug, orgId } });
  const publishedDomain = published
    ? await db.domain.findFirst({ where: { slug: published.domainSlug, orgId }, select: { version: true } })
    : null;
  return buildRoleplayBundle({ ...input, voiceId: resolvedVoice }, {
    slug: agentSlug,
    agentVersion: published?.version ?? 1,
    // Domain id is invisible to the user; keep the published one so versions stay comparable.
    domainId: published?.domainSlug ?? `domain-${agentSlug}`,
    domainVersion: publishedDomain?.version ?? 1,
  });
}
