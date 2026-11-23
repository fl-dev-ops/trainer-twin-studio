import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Who an agent speaks as (specs/agents.md): a twin's own persona, a bot's one persona, or a role play's pool. A new role
 * play session picks one active persona at random (plain random); the session records it (personaSlug/personaVersion).
 */
/** The persona a new session plays when the agent has several; null when it has one (its default). */
export async function pickSessionPersona(agentId: string, client: Prisma.TransactionClient = db): Promise<string | null> {
  const rows = await client.agentPersona.findMany({ where: { agentId, active: true }, orderBy: { position: "asc" }, select: { personaId: true } });
  // One persona: the agent's own default, no override needed.
  if (rows.length < 2) return null;
  return rows[Math.floor(Math.random() * rows.length)].personaId;
}

/** Sets an agent's personas (in order, each switchable); the first active one becomes its default (Agent.personaId). */
export async function setAgentPersonas(agentId: string, personas: { personaId: string; active: boolean }[], tx: Prisma.TransactionClient) {
  const first = personas.find((persona) => persona.active);
  if (!first) throw new Error("An agent needs at least one active persona");
  // The default moves first (its sync trigger keeps one row), then the pool is rewritten; rules are checked at commit.
  await tx.agent.update({ where: { id: agentId }, data: { personaId: first.personaId } });
  await tx.agentPersona.deleteMany({ where: { agentId } });
  await tx.agentPersona.createMany({
    data: personas.map((persona, position) => ({ agentId, personaId: persona.personaId, active: persona.active, position })),
  });
}

/** Keeps an earlier pick if it is still one of the agent's active personas (it may have changed since), else re-picks. */
export async function confirmSessionPersona(agentId: string, picked: string | undefined, tx: Prisma.TransactionClient) {
  if (picked && await tx.agentPersona.findFirst({ where: { agentId, personaId: picked, active: true }, select: { agentId: true } })) {
    const count = await tx.agentPersona.count({ where: { agentId, active: true } });
    if (count > 1) return picked;
  }
  return (await pickSessionPersona(agentId, tx)) ?? undefined;
}
