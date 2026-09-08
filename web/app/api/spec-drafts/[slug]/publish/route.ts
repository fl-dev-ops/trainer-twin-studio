import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { publishSpecDraft, readSpecDraft } from "@/lib/spec-drafts";

export const runtime = "nodejs";

/** Publishes the working draft as the current published Agent + Domain versions. */
export async function POST(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await getTrainerOrg();
  if (!org) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { slug } = await params;

  const draft = await readSpecDraft(slug, org.id).catch(() => null);
  if (!draft) return Response.json({ error: `Draft "${slug}" was not found` }, { status: 404 });
  if (draft.personaSlug) {
    const persona = await db.persona.findFirst({ where: { slug: draft.personaSlug, orgId: org.id }, select: { id: true } });
    if (!persona) return Response.json({ error: "Persona is not available" }, { status: 400 });
  }

  try {
    const result = await publishSpecDraft(slug, org.id);
    return Response.json({ status: result.status, agentVersion: result.agentVersion, domainVersion: result.domainVersion });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Publish failed" }, { status: 400 });
  }
}
