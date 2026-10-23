import { redirect } from "next/navigation";
import { PersonaLibrary } from "@/components/client-persona/persona-library";
import { SpecResourceIndex } from "@/components/spec-resource";
import { listPersonaVoices } from "@/lib/client-persona-data";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { isClientPersonaData } from "@/lib/roleplay";
import { listSpecSummaries } from "@/lib/specs";

export const dynamic = "force-dynamic";

export default async function PersonasPage() {
  const org = await getSessionOrg();
  if (!org) redirect("/auth/no-org");
  if (org.type === "SALES") {
    // Sales orgs manage the client personas learners speak with in role plays.
    const [personas, voices] = await Promise.all([
      db.persona.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" }, select: { slug: true, data: true } }),
      listPersonaVoices(org.id),
    ]);
    return <PersonaLibrary personas={personas.filter((persona) => isClientPersonaData(persona.data))} voices={voices} />;
  }
  return <SpecResourceIndex type="personas" specs={await listSpecSummaries("personas", org.id)} />;
}
