import yaml from "js-yaml";
import { db } from "@/lib/db";
import { getSessionOrg } from "@/lib/org";
import { readSpecDraft, saveSpecDraft } from "@/lib/spec-drafts";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; type: string }> },
) {
  const { slug, type } = await params;
  if (type !== "agent" && type !== "domain") {
    return Response.json({ error: "Type must be agent or domain" }, { status: 400 });
  }
  const draft = await readSpecDraft(slug);
  if (!draft) return Response.json({ error: `Draft "${slug}" was not found` }, { status: 404 });
  const document = { schema_version: 1, kind: type, [type]: draft[type] };
  return new Response(yaml.dump(document, { noRefs: true, lineWidth: 100 }), {
    headers: {
      "content-disposition": `attachment; filename="${slug}.${type}.yaml"`,
      "content-type": "application/yaml; charset=utf-8",
    },
  });
}

/** Update the basic settings exposed by the draft agent editor. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; type: string }> },
) {
  const org = await getSessionOrg();
  if (!org) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { slug, type } = await params;
  if (type !== "agent") return Response.json({ error: "Only agent settings can be updated" }, { status: 400 });
  const draft = await readSpecDraft(slug);
  if (!draft) return Response.json({ error: `Draft "${slug}" was not found` }, { status: 404 });

  const input = await request.json().catch(() => null) as {
    name?: unknown;
    voiceId?: unknown;
    knowledgeBase?: unknown;
  } | null;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const voiceId = typeof input?.voiceId === "string" ? input.voiceId.trim() : "";
  const knowledgeBase = typeof input?.knowledgeBase === "string" ? input.knowledgeBase.trim() : "";
  if (!name) return Response.json({ error: "Agent name is required" }, { status: 400 });

  const [voice, knowledge] = await Promise.all([
    voiceId
      ? db.voice.findFirst({
          where: { id: voiceId, status: "ready", OR: [{ orgId: org.id }, { orgId: null }] },
          select: { id: true },
        })
      : null,
    knowledgeBase
      ? db.knowledgeBase.findFirst({
          where: { slug: knowledgeBase, orgId: org.id },
          select: { id: true },
        })
      : null,
  ]);
  if (voiceId && !voice) return Response.json({ error: "Voice is not available" }, { status: 400 });
  if (knowledgeBase && !knowledge) {
    return Response.json({ error: "Knowledge base is not available" }, { status: 400 });
  }

  const agent = { ...draft.agent, name };
  if (voiceId) agent.voiceId = voiceId;
  else delete agent.voiceId;
  if (knowledgeBase) agent.knowledgeBase = knowledgeBase;
  else delete agent.knowledgeBase;
  const saved = await saveSpecDraft({
    slug: draft.slug,
    name,
    personaSlug: draft.personaSlug,
    agent,
    domain: draft.domain,
    grounding: draft.grounding,
    assumptions: draft.assumptions,
    gaps: draft.gaps,
  });
  await db.specDraft.update({ where: { slug }, data: { orgId: org.id } });
  return Response.json({ revision: saved.revision, changed: saved.changed });
}
