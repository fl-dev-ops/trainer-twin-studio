import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";

const SHARED_KNOWLEDGE_BASE_SLUG = "acme-knowledge";

type Snapshot = {
  agent?: { slug?: string; version?: number; data?: Record<string, unknown> };
  persona?: { slug?: string; version?: number; data?: Record<string, unknown> };
  domain?: { slug?: string; version?: number; data?: Record<string, unknown> };
};

export async function buildSessionContext(input: {
  orgId: string;
  sessionId?: string;
  agentSlug?: string;
  personaSlug?: string;
}) {
  const session = input.sessionId
    ? await db.interviewSession.findFirst({
        where: { id: input.sessionId, orgId: input.orgId },
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
  const domainSlug = session?.domainSlug;
  const snapshot = session?.compiledSnapshot as Snapshot | null;
  const [liveAgent, livePersona, liveDomain, sharedKnowledgeBase] = await Promise.all([
    agentSlug
      ? db.agent.findFirst({ where: { slug: { equals: agentSlug, mode: "insensitive" }, orgId: input.orgId }, select: { slug: true, version: true, data: true } })
      : null,
    personaSlug
      ? db.persona.findFirst({ where: { slug: { equals: personaSlug, mode: "insensitive" }, orgId: input.orgId }, select: { slug: true, version: true, data: true } })
      : null,
    domainSlug
      ? db.domain.findFirst({ where: { slug: domainSlug, orgId: input.orgId }, select: { slug: true, version: true, data: true } })
      : null,
    db.knowledgeBase.findFirst({
      where: {
        slug: SHARED_KNOWLEDGE_BASE_SLUG,
        orgId: input.orgId,
        documents: { some: { status: "indexed" } },
      },
      select: { slug: true, name: true },
    }),
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
  for (const doc of [session?.context, ...(session?.documents?.map((item) => item.document) ?? [])]) {
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

  const user = session?.userId
    ? await db.user.findUnique({ where: { id: session.userId }, select: { name: true } })
    : null;
  const learnerName = (session?.runtimeState as Record<string, unknown> | null)?.learner_name ?? user?.name ?? null;

  const primaryDocId = session?.context?.id ?? session?.documents?.[0]?.document?.id ?? Array.from(docMap.keys())[0];
  let resume: {
    documentId: string;
    extractedText: string;
    claims: Array<{
      id: string;
      claimNo: number;
      section: string;
      kind: string;
      text: string;
      anchor: string;
      metric: string | null;
    }>;
  } | null = null;

  if (primaryDocId) {
    const [docRecord, claims] = await Promise.all([
      db.contextDocument.findFirst({
        where: { id: primaryDocId, orgId: input.orgId },
        select: { id: true, extractedText: true },
      }),
      db.resumeClaim.findMany({
        where: { documentId: primaryDocId },
        orderBy: { claimNo: "asc" },
        select: { id: true, claimNo: true, section: true, kind: true, text: true, anchor: true, metric: true },
      }),
    ]);
    const eligibleKinds = new Set(["project", "experience", "impact", "architecture", "technology"]);
    if (docRecord?.extractedText) {
      resume = {
        documentId: docRecord.id,
        extractedText: docRecord.extractedText,
        claims: claims.filter((claim) => eligibleKinds.has(claim.kind)),
      };
    }
  }

  const agent = snapshot?.agent?.data
    ? { slug: snapshot.agent.slug ?? liveAgent?.slug ?? agentSlug, version: snapshot.agent.version ?? liveAgent?.version ?? 0, data: snapshot.agent.data }
    : liveAgent;
  const persona = snapshot?.persona?.data
    ? { slug: snapshot.persona.slug ?? livePersona?.slug ?? personaSlug, version: snapshot.persona.version ?? livePersona?.version ?? 0, data: snapshot.persona.data }
    : livePersona;
  const domain = snapshot?.domain?.data
    ? { slug: snapshot.domain.slug ?? liveDomain?.slug ?? domainSlug, version: snapshot.domain.version ?? liveDomain?.version ?? 0, data: snapshot.domain.data }
    : liveDomain;

  return {
    sessionId: session?.id ?? input.sessionId ?? null,
    agent: agent ?? null,
    persona: persona ?? null,
    domain: domain ?? null,
    knowledgeBases: sharedKnowledgeBase ? [sharedKnowledgeBase] : [],
    documents: Array.from(docMap.values()),
    learnerName,
    resume,
    warmOpening: session?.warmOpening ?? null,
    uiState: (session?.runtimeState as Record<string, unknown> | null)?.uiState ?? null,
  };
}

/** Session context is immutable after activation; prime this during the intro. */
export const getCachedSessionContext = unstable_cache(
  (orgId: string, sessionId: string) => buildSessionContext({ orgId, sessionId }),
  ["session-context-v1"],
  { revalidate: 86_400 },
);
