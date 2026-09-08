import { NextResponse } from "next/server";
import { authorizeRuntimeSession } from "@/lib/interview-sessions";
import { db } from "@/lib/db";
import { knowledgeCollectionName, searchCollection } from "@/lib/knowledge";
import { personaCollectionName } from "@/lib/persona-voice";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const session = await authorizeRuntimeSession(id, token);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 2000) : "";
  const limit = Math.min(Math.max(Number(body?.limit) || 4, 1), 8);
  if (!query || !["knowledge", "persona"].includes(body?.kind)) {
    return NextResponse.json({ error: "kind and query are required" }, { status: 400 });
  }

  const agent = await db.agent.findFirst({
    where: { id: session.agentId, orgId: session.orgId },
    include: { persona: { select: { id: true } } },
  });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  try {
    if (body.kind === "persona") {
      const action = typeof body.action === "string" ? body.action.slice(0, 100) : "";
      const hits = await searchCollection(personaCollectionName(agent.persona.id), `${query}\nAction: ${action}`, limit);
      return NextResponse.json({ hits });
    }

    const domain = await db.domain.findFirst({ where: { slug: agent.domainSlug, orgId: session.orgId } });
    if (!domain) return NextResponse.json({ error: "Agent domain not found" }, { status: 409 });
    const attached = isRecord(agent.data) && typeof agent.data.knowledgeBase === "string" ? [agent.data.knowledgeBase] : [];
    const domainBases = isRecord(domain.data) && Array.isArray(domain.data.knowledge_bases)
      ? domain.data.knowledge_bases.filter((value): value is string => typeof value === "string")
      : [];
    const allowed = new Set(attached.length ? attached : domainBases);
    const supplied = Array.isArray(body.knowledgeBases)
      ? body.knowledgeBases.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const requested = allowed.size ? supplied.filter((value: string) => allowed.has(value)) : supplied;
    const bases = await db.knowledgeBase.findMany({
      where: {
        orgId: session.orgId,
        ...(requested.length ? { slug: { in: requested } } : {}),
        documents: { some: { status: "indexed" } },
      },
      select: { id: true, slug: true },
    });
    const results = await Promise.all(bases.map(async (base) =>
      (await searchCollection(knowledgeCollectionName(base.id), query, limit))
        .map((hit) => ({ ...hit, knowledgeBase: base.slug }))));
    const hits = results.flat().sort((a, b) => b.score - a.score).slice(0, limit);
    return NextResponse.json({ hits });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Retrieval failed", hits: [] });
  }
}
