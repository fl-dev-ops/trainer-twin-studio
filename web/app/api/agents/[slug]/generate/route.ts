import { z } from "zod";
import { db } from "@/lib/db";
import { getTrainerOrg } from "@/lib/org";
import { readSpecDraft, saveSpecDraft, publishSpecDraft } from "@/lib/spec-drafts";
import { generateSpecBundle } from "@/lib/spec-generation";
import { validSlug } from "@/lib/specs";
import { interviewConfigSchema } from "@/lib/interview-config-schema";
import { QuestionBank } from "@/lib/question-bank";

export const runtime = "nodejs";
export const maxDuration = 120;

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
const inputSchema = z.object({
  instruction: z.string().trim().min(1, "Describe how the scenario should work").max(10000),
  name: z.string().trim().min(1, "Name is required").max(120),
  opening: z.string().trim().min(1, "First message is required").max(2000),
  personaSlug: slug,
  knowledgeBase: slug.optional(),
  voiceId: z.string().optional(),
  publish: z.boolean().optional(),
  interviewConfig: interviewConfigSchema,
  contextPrompt: z.string().trim().max(500).optional(),
});

const GENERIC_SAVE_ERROR = "Failed to save the change, try again in a few seconds";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const org = await getTrainerOrg();
  if (!org) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { slug: agentSlug } = await params;
  if (!validSlug(agentSlug)) return Response.json({ error: "Invalid scenario id" }, { status: 400 });

  const input = inputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return Response.json({ error: input.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { instruction, name, opening, personaSlug, knowledgeBase, voiceId, publish, interviewConfig } = input.data;

  if (interviewConfig.type === "technical" && !knowledgeBase) {
    return Response.json({ error: "Technical scenarios require a knowledge base" }, { status: 400 });
  }
  if (publish && interviewConfig.type === "technical" && !interviewConfig.topic_slugs.length) {
    return Response.json({ error: "Select at least one generated question topic before publishing" }, { status: 400 });
  }

  const persona = await db.persona.findUnique({
    where: { orgId_slug: { orgId: org.id, slug: personaSlug } },
    select: { id: true, name: true },
  });
  if (!persona) return Response.json({ error: "Persona is not available" }, { status: 400 });

  const [voice, knowledge] = await Promise.all([
    voiceId
      ? db.voice.findFirst({ where: { id: voiceId, status: "ready", OR: [{ orgId: org.id }, { orgId: null }] }, select: { id: true } })
      : Promise.resolve(null),
    knowledgeBase
      ? db.knowledgeBase.findFirst({ where: { slug: knowledgeBase, orgId: org.id }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (voiceId && !voice) return Response.json({ error: "Voice is not available" }, { status: 400 });
  if (knowledgeBase && !knowledge) return Response.json({ error: "Knowledge base is not available" }, { status: 400 });
  if (interviewConfig.type === "technical") {
    const approvedTopics = await db.topic.findMany({
      where: { status: "approved", slug: { in: interviewConfig.topic_slugs } },
      select: { slug: true },
    });
    if (approvedTopics.length !== new Set(interviewConfig.topic_slugs).size) {
      return Response.json({ error: "One or more selected topics are not approved" }, { status: 400 });
    }
    const availableTopics = new Set(await QuestionBank.listTopicSlugs(org.id, [knowledgeBase!]));
    if (interviewConfig.topic_slugs.some((topic) => !availableTopics.has(topic))) {
      return Response.json({ error: "One or more selected topics have no generated questions in this knowledge base" }, { status: 400 });
    }
  }

  try {
    const [published, draft] = await Promise.all([
      db.agent.findFirst({ where: { slug: agentSlug, orgId: org.id } }),
      readSpecDraft(agentSlug, org.id).catch(() => null),
    ]);
    const publishedDomain = published
      ? await db.domain.findFirst({ where: { slug: published.domainSlug, orgId: org.id } })
      : null;

    // Domain id is invisible to the user; keep the published one so versions stay comparable.
    const domainId = published?.domainSlug ?? `domain-${agentSlug}`;

    const generated = await generateSpecBundle({
      slug: agentSlug,
      instruction,
      name,
      opening,
      personaName: persona.name,
      knowledgeBase,
      interviewConfig,
      contextPrompt: input.data.contextPrompt,
      previous: draft
        ? { instruction: draft.agent.instruction, agent: draft.agent, domain: draft.domain }
        : published
          ? { agent: published.data, domain: publishedDomain?.data ?? {} }
          : null,
    });

    const bundle = {
      slug: agentSlug,
      name,
      personaSlug,
      agent: {
        ...generated.agent,
        id: agentSlug,
        name,
        version: published?.version ?? 1,
        opening,
        domain: domainId,
        instruction,
        ...(knowledgeBase ? { knowledgeBase } : {}),
        ...(voiceId ? { voiceId } : {}),
      },
      domain: {
        ...generated.domain,
        id: domainId,
        version: publishedDomain?.version ?? 1,
        knowledge_bases: knowledgeBase ? [knowledgeBase] : [],
      },
      grounding: knowledgeBase
        ? generated.grounding.filter((reference) => reference.knowledgeBase === knowledgeBase)
        : [],
      assumptions: generated.assumptions,
      gaps: [],
    };

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
    console.error("Scenario generation failed", error);
    return Response.json({ error: GENERIC_SAVE_ERROR }, { status: 502 });
  }
}
