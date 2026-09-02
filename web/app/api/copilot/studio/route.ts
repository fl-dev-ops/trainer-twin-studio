import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { searchKnowledge, topicFilterSchema } from "@/lib/knowledge";
import { specDraftBundleSchema } from "@/lib/spec-draft-schema";
import { publishSpecDraft, readSpecDraft, saveSpecDraft } from "@/lib/spec-drafts";

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
    topicFilter: topicFilterSchema.optional(),
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
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid Copilot request" }, { status: 400 });

  try {
    const input = parsed.data;
    if (input.action === "inventory") {
      const [personas, agents, domains, knowledgeBases, drafts] = await Promise.all([
        db.persona.findMany({ orderBy: { slug: "asc" }, select: { slug: true, name: true, version: true } }),
        db.agent.findMany({ orderBy: { slug: "asc" }, select: { slug: true, name: true, version: true, domainSlug: true } }),
        db.domain.findMany({ orderBy: { slug: "asc" }, select: { slug: true, name: true, version: true } }),
        db.knowledgeBase.findMany({
          orderBy: { slug: "asc" },
          select: { slug: true, name: true, documents: { select: { title: true, status: true } } },
        }),
        db.specDraft.findMany({
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
        ? await db.persona.findUnique({ where: { slug: input.slug }, select: { slug: true, version: true, data: true } })
        : input.type === "agent"
          ? await db.agent.findUnique({ where: { slug: input.slug }, select: { slug: true, version: true, data: true } })
          : await db.domain.findUnique({ where: { slug: input.slug }, select: { slug: true, version: true, data: true } });
      return Response.json(row ?? { error: `${input.type} "${input.slug}" was not found` });
    }

    if (input.action === "readDraft") {
      return Response.json(await readSpecDraft(input.slug) ?? { error: `Draft "${input.slug}" was not found` });
    }

    if (input.action === "saveDraft") {
      const saved = await saveSpecDraft(input.bundle);
      return Response.json({
        slug: saved.slug,
        name: saved.name,
        status: saved.status,
        revision: saved.revision,
        changed: saved.changed,
      });
    }

    if (input.action === "publishDraft") {
      return Response.json(await publishSpecDraft(input.slug));
    }

    const exists = await db.knowledgeDocument.findFirst({
      where: { status: "indexed", kb: { slug: input.knowledgeBase } },
      select: { id: true },
    });
    if (!exists) return Response.json({ error: `No indexed knowledge base named "${input.knowledgeBase}"` });
    const results = await searchKnowledge(input.knowledgeBase, input.query, input.limit, { topicFilter: input.topicFilter });
    return Response.json({
      query: input.query,
      knowledgeBase: input.knowledgeBase,
      results: results.map(({ docId, source, text, score }) => ({ docId, source, text, score })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Copilot request failed" }, { status: 500 });
  }
}
