import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { personaBrief } from "@/lib/persona";
import { findOrgOrGlobalPersona } from "@/lib/specs";
import { type PinnedTwinSkill, twinPlaybooks, sessionTwinPlaybooks } from "@/lib/twins";
import { runsAsMainTwin } from "@/lib/main-twin";
import { loadSessionSkills } from "@/lib/session-skills";
import { hydrateAgentSkill } from "@/lib/skill-history";

const SHARED_KNOWLEDGE_BASE_SLUG = "acme-knowledge";

type Snapshot = {
  agent?: { slug?: string; version?: number; data?: Record<string, unknown> };
  persona?: { slug?: string; version?: number; data?: Record<string, unknown> };
  /** All-skills twin sessions: the skill twins pinned when the session started. */
  twinSkills?: PinnedTwinSkill[];
};

export async function buildSessionContext(input: {
  orgId: string;
  sessionId?: string;
  agentSlug?: string;
  personaSlug?: string;
}) {
  const managedSkill = input.sessionId
    ? await loadSessionSkills(input.orgId, input.sessionId, input.agentSlug)
    : null;
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
  const anonymous = Boolean(session?.anonymousId);
  const personaSlug = session?.personaSlug ?? input.personaSlug;
  const snapshot = session?.compiledSnapshot as Snapshot | null;
  const [savedAgent, livePersona, sharedKnowledgeBase] = await Promise.all([
    agentSlug
      ? db.agent.findFirst({ where: { slug: { equals: agentSlug, mode: "insensitive" }, orgId: input.orgId }, select: { id: true, slug: true, primarySkillId: true, version: true, data: true, personaId: true, kind: true } })
      : null,
    personaSlug
      ? findOrgOrGlobalPersona(input.orgId, { equals: personaSlug, mode: "insensitive" }, { slug: true, version: true, data: true, isOwn: true })
      : null,
    anonymous ? null : db.knowledgeBase.findFirst({
      where: {
        slug: SHARED_KNOWLEDGE_BASE_SLUG,
        orgId: input.orgId,
        documents: { some: { status: "indexed" } },
      },
      select: { slug: true, name: true },
    }),
  ]);
  const liveAgent = !managedSkill && !snapshot?.agent?.data && savedAgent?.primarySkillId
    ? await hydrateAgentSkill(input.orgId, savedAgent)
    : savedAgent;

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
  for (const doc of anonymous ? [] : [session?.context, ...(session?.documents?.map((item) => item.document) ?? [])]) {
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

  const user = !anonymous && session?.userId
    ? await db.user.findUnique({ where: { id: session.userId }, select: { name: true } })
    : null;
  const learnerName = anonymous ? session?.anonymousName ?? null : (session?.runtimeState as Record<string, unknown> | null)?.learner_name ?? user?.name ?? null;

  const agent = managedSkill
    ? { slug: session!.agentSlug, version: session!.agentVersion, data: managedSkill.data }
    : snapshot?.agent?.data
    ? { slug: snapshot.agent.slug ?? liveAgent?.slug ?? agentSlug, version: snapshot.agent.version ?? liveAgent?.version ?? 0, data: snapshot.agent.data }
    : liveAgent;
  const persona = snapshot?.persona?.data
    ? { slug: snapshot.persona.slug ?? livePersona?.slug ?? personaSlug, version: snapshot.persona.version ?? livePersona?.version ?? 0, data: snapshot.persona.data }
    : livePersona;

  // The all-skills twin draws on its persona's skill twins: the ones pinned when the session started (older
  // sessions without a pin get the live list). kind is immutable, so the live row's kind is the session's module.
  const isAllSkillsTwin = managedSkill ? managedSkill.isMainTwin : runsAsMainTwin(liveAgent?.kind, agent?.data);
  const playbooks = managedSkill?.isMainTwin
    ? await sessionTwinPlaybooks(input.orgId, managedSkill)
    : isAllSkillsTwin && liveAgent?.personaId
    ? await twinPlaybooks(input.orgId, liveAgent.personaId, Array.isArray(snapshot?.twinSkills) ? snapshot.twinSkills : undefined)
    : undefined;

  return {
    sessionId: session?.id ?? input.sessionId ?? null,
    agent: agent ? { slug: agent.slug, version: agent.version, kind: managedSkill?.kind ?? liveAgent?.kind ?? null, data: agent.data } : null,
    ...(playbooks ? { twinPlaybooks: playbooks } : {}),
    persona: persona ?? null,
    // The trainer's own persona speaks as herself (identity only); any other persona is a character to play.
    personaBrief: persona ? personaBrief(persona.data, livePersona?.isOwn ? "self" : "character") : null,
    knowledgeBases: sharedKnowledgeBase ? [sharedKnowledgeBase] : [],
    documents: Array.from(docMap.values()),
    learnerName,
    ...(anonymous ? { visitor: { kind: "anonymous" as const, name: session?.anonymousName ?? "" } } : {}),
    warmOpening: anonymous ? null : session?.warmOpening ?? null,
    uiState: anonymous ? null : (session?.runtimeState as Record<string, unknown> | null)?.uiState ?? null,
  };
}

/** Session context is immutable after activation; prime this during the intro. */
const cachedSessionContext = unstable_cache(
  (orgId: string, sessionId: string) => buildSessionContext({ orgId, sessionId }),
  ["session-context-v3"],
  { revalidate: 86_400 },
);

export async function getCachedSessionContext(orgId: string, sessionId: string) {
  await loadSessionSkills(orgId, sessionId);
  return cachedSessionContext(orgId, sessionId);
}
