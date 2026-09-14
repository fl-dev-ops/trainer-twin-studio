import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { searchKnowledge } from "@/lib/knowledge";
import { specDraftBundleSchema } from "@/lib/spec-draft-schema";
import { publishSpecDraft, readSpecDraft, saveSpecDraft } from "@/lib/spec-drafts";
import { MainCollectionService } from "@/lib/main-collection";
import { redactLearnerNames } from "@/lib/persona-voice";

export const runtime = "nodejs";

const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inventory") }).strict(),
  z.object({ action: z.literal("readSpec"), type: z.enum(["persona", "agent", "domain"]), slug }).strict(),
  z.object({ action: z.literal("readDraft"), slug }).strict(),
  z.object({ action: z.literal("saveDraft"), bundle: specDraftBundleSchema }).strict(),
  z.object({ action: z.literal("publishDraft"), slug }).strict(),
  z.object({
    action: z.literal("searchKnowledge"),
    knowledgeBase: slug,
    query: z.string().trim().min(2).max(500),
    limit: z.number().int().min(1).max(8),
  }).strict(),
  z.object({
    action: z.literal("searchStyleEpisodes"),
    personaSlug: slug,
    query: z.string().trim().min(2).max(500),
    sessionPhase: z.enum(["opening", "middle", "closing"]).optional(),
    limit: z.number().int().min(1).max(10).optional(),
    styleFilters: z.object({
      usesLearnerName: z.boolean().optional(),
      startsWithThanks: z.boolean().optional(),
      hasDoubledAcknowledgement: z.boolean().optional(),
    }).optional(),
  }).strict(),
  z.object({
    action: z.literal("readDocument"),
    documentId: z.string().trim().min(1).max(120),
    query: z.string().trim().min(1).max(500).optional(),
    section: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  z.object({
    action: z.literal("getSessionContext"),
    sessionId: z.string().optional(),
    agentSlug: z.string().optional(),
    personaSlug: z.string().optional(),
  }).strict(),
  z.object({
    action: z.literal("getPersonaStyleMoments"),
    personaSlug: slug,
  }).strict(),
]);

function authorized(request: Request) {
  const expected = process.env.COPILOT_SERVICE_SECRET;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  if (!orgId) return Response.json({ error: "Organization is required" }, { status: 400 });
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid Copilot request" }, { status: 400 });
  const input = parsed.data;

  if (input.action === "readDocument") {
    const doc = await db.contextDocument.findFirst({
      where: { id: input.documentId, orgId },
      include: {
        chunks: { orderBy: { chunkIndex: "asc" } },
      },
    });
    if (!doc) return Response.json({ error: `Document "${input.documentId}" not found` }, { status: 404 });

    let chunks = doc.chunks;
    if (input.section) {
      const sec = input.section.toLowerCase();
      const matched = chunks.filter((c) => c.heading?.toLowerCase().includes(sec));
      if (matched.length > 0) chunks = matched;
    }
    if (input.query) {
      const qTerms = input.query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      const matched = chunks.filter((c) => {
        const txt = (c.text + " " + (c.heading ?? "")).toLowerCase();
        return qTerms.some((term) => txt.includes(term));
      });
      if (matched.length > 0) chunks = matched;
    }

    return Response.json({
      documentId: doc.id,
      name: doc.name,
      kind: doc.kind,
      chunks: chunks.map((c) => ({
        index: c.chunkIndex,
        heading: c.heading,
        pageNumber: c.pageNumber,
        text: c.text,
      })),
    });
  }

  if (input.action === "getSessionContext") {
    const session = input.sessionId
      ? await db.interviewSession.findFirst({
          where: { id: input.sessionId, orgId },
          include: {
            context: { select: { id: true, name: true, mimeType: true, kind: true, size: true, manifest: true } },
            documents: {
              include: {
                document: { select: { id: true, name: true, mimeType: true, kind: true, size: true, manifest: true } },
              },
            },
          },
        })
      : null;

    const agentSlug = session?.agentSlug ?? input.agentSlug;
    const personaSlug = session?.personaSlug ?? input.personaSlug;

    const [agent, persona] = await Promise.all([
      agentSlug
        ? db.agent.findFirst({ where: { slug: { equals: agentSlug, mode: "insensitive" }, orgId }, select: { slug: true, version: true, data: true } })
        : null,
      personaSlug
        ? db.persona.findFirst({ where: { slug: { equals: personaSlug, mode: "insensitive" }, orgId }, select: { slug: true, version: true, data: true } })
        : null,
    ]);

    const docMap = new Map<string, {
      id: string;
      name: string;
      kind: string;
      mimeType: string;
      size: number;
      pageCount?: number;
      summary?: string;
      headings?: string[];
    }>();
    if (session?.context) {
      const manifest = session.context.manifest as { pageCount?: number; summary?: string; headings?: string[] } | null;
      docMap.set(session.context.id, {
        id: session.context.id,
        name: session.context.name,
        kind: session.context.kind,
        mimeType: session.context.mimeType,
        size: session.context.size,
        pageCount: manifest?.pageCount,
        summary: manifest?.summary,
        headings: manifest?.headings,
      });
    }
    if (session?.documents) {
      for (const d of session.documents) {
        const doc = d.document;
        if (!doc) continue;
        const manifest = doc.manifest as { pageCount?: number; summary?: string; headings?: string[] } | null;
        docMap.set(doc.id, {
          id: doc.id,
          name: doc.name,
          kind: doc.kind,
          mimeType: doc.mimeType,
          size: doc.size,
          pageCount: manifest?.pageCount,
          summary: manifest?.summary,
          headings: manifest?.headings,
        });
      }
    }

    const user = session?.userId
      ? await db.user.findUnique({ where: { id: session.userId }, select: { id: true, name: true } })
      : null;
    const learnerName = (session?.runtimeState as Record<string, unknown> | null)?.learner_name ?? user?.name ?? null;
    let isReturningLearner = false;
    let pastSessionCount = 0;
    let lastSessionDate: string | null = null;

    if (session?.userId) {
      const past = await db.interviewSession.findMany({
        where: {
          orgId,
          userId: session.userId,
          ...(session?.id ? { id: { not: session.id } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, createdAt: true, agentSlug: true },
      });
      if (past.length > 0) {
        isReturningLearner = true;
        pastSessionCount = past.length;
        lastSessionDate = past[0].createdAt.toISOString();
      }
    }

    return Response.json({
      sessionId: session?.id ?? input.sessionId ?? null,
      agent: agent ?? null,
      persona: persona ?? null,
      documents: Array.from(docMap.values()),
      learnerName,
      learnerHistory: {
        isReturning: isReturningLearner,
        pastSessionCount,
        lastSessionDate,
      },
    });
  }

  if (input.action === "getPersonaStyleMoments") {
    const persona = await db.persona.findFirst({
      where: { slug: { equals: input.personaSlug, mode: "insensitive" }, orgId },
      select: { id: true, name: true, slug: true },
    });
    if (!persona) return Response.json({ error: `No persona named "${input.personaSlug}"` });
    const moments = await MainCollectionService.getRawStyleEpisodesForPersona(orgId, persona.id);
    return Response.json({ personaSlug: persona.slug, personaName: persona.name, moments });
  }

  if (input.action === "searchStyleEpisodes") {
    const persona = await db.persona.findFirst({
      where: { slug: { equals: input.personaSlug, mode: "insensitive" }, orgId },
      select: { id: true, name: true },
    });
    if (!persona) return Response.json({ error: `No persona named "${input.personaSlug}"` });

    const [styleHits, episodeHits] = await Promise.all([
      MainCollectionService.searchStyleEpisodes(orgId, input.query, {
        personaId: persona.id,
        sessionPhase: input.sessionPhase,
        limit: input.limit,
        diversify: true,
        styleFilters: input.styleFilters,
      }),
      MainCollectionService.searchPersonaEpisodes(orgId, input.query, {
        personaId: persona.id,
        sessionPhase: input.sessionPhase,
        limit: 2,
        diversify: true,
      }),
    ]);

    return Response.json({
      query: input.query,
      persona: persona.name,
      pastExchanges: episodeHits.map((hit) => ({
        exchange: redactLearnerNames(hit.text, []),
        score: hit.score,
      })),
      phrasingStyle: styleHits.map((hit) => {
        const pastName = hit.pastLearnerName;
        return {
          text: redactLearnerNames(hit.text, [pastName]),
          score: hit.score,
          metadata: {
            sessionPhase: hit.sessionPhase,
            styleFunction: redactLearnerNames(hit.styleFunction ?? "", [pastName]),
            styleShape: redactLearnerNames(hit.styleShape ?? "", [pastName]),
            usesLearnerName: hit.usesLearnerName,
            startsWithThanks: hit.startsWithThanks,
            hasDoubledAcknowledgement: hit.hasDoubledAcknowledgement,
          },
        };
      }),
    });
  }

  try {
    if (input.action === "inventory") {
      const [personas, agents, domains, knowledgeBases, drafts] = await Promise.all([
        db.persona.findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true, name: true, version: true } }),
        db.agent.findMany({ where: { orgId }, orderBy: [{ order: "asc" }, { slug: "asc" }], select: { slug: true, name: true, version: true, domainSlug: true } }),
        db.domain.findMany({ where: { orgId }, orderBy: { slug: "asc" }, select: { slug: true, name: true, version: true } }),
        db.knowledgeBase.findMany({
          where: { orgId },
          orderBy: { slug: "asc" },
          select: { slug: true, name: true, documents: { select: { title: true, status: true } } },
        }),
        db.specDraft.findMany({
          where: { orgId },
          orderBy: { updatedAt: "desc" },
          select: { slug: true, name: true, status: true, revision: true, updatedAt: true },
        }),
      ]);
      return Response.json({
        personas,
        agents,
        domains,
        knowledgeBases,
        drafts: drafts.map((draft) => ({ ...draft, updatedAt: draft.updatedAt.toISOString() })),
      });
    }

    if (input.action === "readSpec") {
      const row = input.type === "persona"
        ? await db.persona.findFirst({ where: { slug: input.slug, orgId }, select: { slug: true, version: true, data: true } })
        : input.type === "agent"
          ? await db.agent.findFirst({ where: { slug: input.slug, orgId }, select: { slug: true, version: true, data: true } })
          : await db.domain.findFirst({ where: { slug: input.slug, orgId }, select: { slug: true, version: true, data: true } });
      return Response.json(row ?? { error: `${input.type} "${input.slug}" was not found` });
    }

    if (input.action === "readDraft") {
      return Response.json(await readSpecDraft(input.slug, orgId) ?? { error: `Draft "${input.slug}" was not found` });
    }

    if (input.action === "saveDraft") {
      const saved = await saveSpecDraft(input.bundle, orgId);
      return Response.json({
        slug: saved.slug,
        name: saved.name,
        status: saved.status,
        revision: saved.revision,
        changed: saved.changed,
      });
    }

    if (input.action === "publishDraft") {
      return Response.json(await publishSpecDraft(input.slug, orgId));
    }

    const knowledgeBase = await db.knowledgeBase.findFirst({
      where: { slug: input.knowledgeBase, orgId, documents: { some: { status: "indexed" } } },
      select: { id: true },
    });
    if (!knowledgeBase) return Response.json({ error: `No indexed knowledge base named "${input.knowledgeBase}"` });
    const results = await searchKnowledge(knowledgeBase.id, input.query, input.limit, orgId);
    return Response.json({
      query: input.query,
      knowledgeBase: input.knowledgeBase,
      results: results.map(({ docId, source, text, score }) => ({ docId, source, text, score })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Copilot request failed" }, { status: 500 });
  }
}
