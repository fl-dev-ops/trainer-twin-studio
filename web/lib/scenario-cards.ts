import { db } from "@/lib/db";
import { getStoredRoleplay } from "@/lib/roleplay";
import { agentDisplayName } from "@/lib/specs";

/**
 * Everything the Scenarios list shows for one scenario, built only from data
 * that exists: the spec, its persona, and the sessions learners actually ran.
 */
export type ScenarioCard = {
  slug: string;
  name: string;
  kind: "roleplay" | "twin";
  status: "published" | "draft";
  /** Published scenario with unpublished edits. */
  draftRevision?: number;
  /** Small caps label on the card: client role for role plays, interview type for Twins. */
  label: string;
  /** Who speaks in the card bubble and the line they open with. */
  speaker: string;
  speakerAvatar?: string;
  quote?: string;
  description?: string;
  persona: { name: string; avatar?: string };
  sessions: number;
  /** Average report score on a 0–10 scale, or null when no session has a report yet. */
  avgScore: number | null;
  lastActivity: string | null;
  learners: { name: string; image?: string }[];
  learnerCount: number;
};

type AgentData = Record<string, unknown> | null;

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function interviewLabel(data: AgentData): string {
  const config = data?.config as { interview?: { type?: unknown } } | undefined;
  const type = config?.interview?.type;
  return type === "technical" ? "Twin · Technical" : type === "resume" ? "Twin · Resume" : "Twin";
}

export async function listScenarioCards(orgId: string): Promise<ScenarioCard[]> {
  const [agents, drafts, personas] = await Promise.all([
    db.agent.findMany({
      where: { orgId },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, slug: true, name: true, data: true, personaId: true, updatedAt: true },
    }),
    db.specDraft.findMany({
      where: { orgId },
      orderBy: { name: "asc" },
      select: { slug: true, name: true, status: true, revision: true, agentData: true, personaSlug: true, updatedAt: true },
    }),
    db.persona.findMany({ where: { orgId }, select: { id: true, slug: true, name: true, data: true } }),
  ]);

  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  const personaBySlug = new Map(personas.map((persona) => [persona.slug, persona]));
  const draftsBySlug = new Map(drafts.map((draft) => [draft.slug, draft]));

  const agentIds = agents.map((agent) => agent.id);
  const sessions = agentIds.length
    ? await db.interviewSession.findMany({
        where: { orgId, agentId: { in: agentIds }, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          agentId: true,
          createdAt: true,
          endedAt: true,
          report: true,
          user: { select: { id: true, name: true, image: true } },
        },
      })
    : [];

  type Stats = {
    sessions: number;
    scores: number[];
    lastActivity: Date | null;
    learners: Map<string, { name: string; image?: string }>;
  };
  const statsByAgent = new Map<string, Stats>();
  for (const session of sessions) {
    const stats: Stats = statsByAgent.get(session.agentId) ?? { sessions: 0, scores: [], lastActivity: null, learners: new Map() };
    stats.sessions += 1;
    const score = (session.report as { score?: unknown } | null)?.score;
    if (typeof score === "number" && Number.isFinite(score)) stats.scores.push(score);
    const at = session.endedAt ?? session.createdAt;
    if (!stats.lastActivity || at > stats.lastActivity) stats.lastActivity = at;
    if (session.user && !stats.learners.has(session.user.id)) {
      stats.learners.set(session.user.id, { name: session.user.name, image: session.user.image ?? undefined });
    }
    statsByAgent.set(session.agentId, stats);
  }

  function card(input: {
    slug: string;
    name: string;
    status: "published" | "draft";
    draftRevision?: number;
    data: AgentData;
    persona?: { name: string; data: unknown } | null;
    stats?: Stats;
  }): ScenarioCard {
    const roleplay = getStoredRoleplay(input.data);
    const personaData = (input.persona?.data ?? {}) as Record<string, unknown>;
    const personaName = input.persona?.name ?? "No persona";
    const personaAvatar = str(personaData.avatar);
    const stats = input.stats;
    const learners = stats ? [...stats.learners.values()] : [];
    const base = {
      slug: input.slug,
      name: agentDisplayName(input.slug, input.name),
      status: input.status,
      draftRevision: input.draftRevision,
      quote: str(input.data?.opening),
      persona: { name: personaName, avatar: personaAvatar },
      sessions: stats?.sessions ?? 0,
      avgScore: stats?.scores.length
        ? Math.round((stats.scores.reduce((sum, value) => sum + value, 0) / stats.scores.length) / 10 * 10) / 10
        : null,
      lastActivity: stats?.lastActivity?.toISOString() ?? null,
      learners: learners.slice(0, 4),
      learnerCount: learners.length,
    };
    if (roleplay) {
      return {
        ...base,
        kind: "roleplay",
        label: str(personaData.role) ?? "Client",
        speaker: roleplay.client_name ?? personaName,
        speakerAvatar: personaAvatar,
        description: roleplay.situation?.scenario,
      };
    }
    return {
      ...base,
      kind: "twin",
      label: interviewLabel(input.data),
      speaker: personaName,
      speakerAvatar: personaAvatar,
      description: str(input.data?.objective),
    };
  }

  const published = new Set(agents.map((agent) => agent.slug));
  return [
    ...agents.map((agent) => {
      const draft = draftsBySlug.get(agent.slug);
      return card({
        slug: agent.slug,
        name: agent.name,
        status: "published",
        draftRevision: draft?.status === "draft" ? draft.revision : undefined,
        data: agent.data as AgentData,
        persona: personaById.get(agent.personaId) ?? null,
        stats: statsByAgent.get(agent.id),
      });
    }),
    ...drafts
      .filter((draft) => !published.has(draft.slug))
      .map((draft) => card({
        slug: draft.slug,
        name: draft.name,
        status: "draft",
        draftRevision: draft.revision,
        data: draft.agentData as AgentData,
        persona: draft.personaSlug ? personaBySlug.get(draft.personaSlug) ?? null : null,
      })),
  ];
}
