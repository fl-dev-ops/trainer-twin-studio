import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { agentDisplayName } from "@/lib/specs";

/** The role play being calibrated and the persona it speaks as, scoped to the trainer's org. */
export async function calibrationAgent(slug: string) {
  const org = await getTrainerOrg();
  if (!org) redirect("/auth/no-org");
  const agent = await db.agent.findFirst({
    where: { slug, orgId: org.id },
    select: { slug: true, name: true, persona: { select: { name: true } } },
  });
  if (!agent) notFound();
  return { slug: agent.slug, scenarioName: agentDisplayName(agent.slug, agent.name), twinName: agent.persona.name };
}
