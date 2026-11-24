import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Who an agent speaks as (specs/agents.md): a twin's own persona, a bot's one persona, or a role play's pool. A new role
 * play session picks one active persona at random (plain random); the session records it (personaSlug/personaVersion).
 */
/**
 * The personas that may play a new role play session: the active ones with a character for it (a persona without one
 * has nothing to play there). Other agents: their active personas.
 */
export async function eligiblePersonas(agentId: string, client: Prisma.TransactionClient = db): Promise<string[]> {
  const agent = await client.agent.findUnique({ where: { id: agentId }, select: { kind: true } });
  const rows = await client.agentPersona.findMany({ where: { agentId, active: true }, orderBy: { position: "asc" }, select: { personaId: true, character: true } });
  return (agent?.kind === "ROLEPLAY" ? rows.filter((row) => row.character?.trim()) : rows).map((row) => row.personaId);
}

/** The persona a new session plays when it isn't the agent's default; null when the default plays (or is the only one). */
export async function pickSessionPersona(agentId: string, client: Prisma.TransactionClient = db): Promise<string | null> {
  const ids = await eligiblePersonas(agentId, client);
  if (!ids.length) return null;
  if (ids.length > 1) return ids[Math.floor(Math.random() * ids.length)];
  // One may play: the default needs no override; another (the default has no character) is that one.
  const main = await client.agent.findUnique({ where: { id: agentId }, select: { personaId: true } });
  return ids[0] === main?.personaId ? null : ids[0];
}

/** Sets an agent's personas (in order, each switchable); the first active one becomes its default (Agent.personaId). */
export async function setAgentPersonas(agentId: string, personas: { personaId: string; active: boolean }[], tx: Prisma.TransactionClient) {
  const first = personas.find((persona) => persona.active);
  if (!first) throw new Error("An agent needs at least one active persona");
  // The default moves first (its sync trigger keeps one row), then the pool is rewritten; rules are checked at commit.
  await tx.agent.update({ where: { id: agentId }, data: { personaId: first.personaId } });
  // Each persona keeps its character for this role play; one dropped from the pool loses it.
  const kept = new Map((await tx.agentPersona.findMany({ where: { agentId }, select: { personaId: true, character: true } }))
    .map((row) => [row.personaId, row.character]));
  await tx.agentPersona.deleteMany({ where: { agentId } });
  await tx.agentPersona.createMany({
    data: personas.map((persona, position) => ({ agentId, personaId: persona.personaId, active: persona.active, position, character: kept.get(persona.personaId) ?? null })),
  });
}

/** Keeps an earlier pick if it may still play (the pool may have changed since), else re-picks. */
export async function confirmSessionPersona(agentId: string, picked: string | undefined, tx: Prisma.TransactionClient) {
  if (picked && (await eligiblePersonas(agentId, tx)).includes(picked)) return picked;
  return (await pickSessionPersona(agentId, tx)) ?? undefined;
}
