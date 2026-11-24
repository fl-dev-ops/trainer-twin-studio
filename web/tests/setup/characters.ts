import { db } from "@/lib/db";

/** Gives every persona of a role play without a character one, as the studio requires before a session can start. */
export async function giveCharacters(agent: string | { slug: string }, character = "## Who you are here\n\nThe client on this call.") {
  const where = typeof agent === "string" ? { agentId: agent } : { agent: { slug: agent.slug } };
  await db.agentPersona.updateMany({ where: { ...where, character: null }, data: { character } });
}
