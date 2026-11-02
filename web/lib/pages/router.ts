import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { awaitingUsers } from "@/lib/awaiting-users";
import { db } from "@/lib/db";
import { loadLatestFidelityReport } from "@/lib/fidelity-report.server";
import { listLearners } from "@/lib/learners";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";
import { isStudioRole, parseAccentColor } from "@/lib/org";
import { getPersonaBaseline } from "@/lib/persona-baseline";
import { agentPhotoUrls, pickableVoices } from "@/lib/persona-media";
import { getPersona, listPersonas } from "@/lib/personas";
import { loadSharedSession, loadTwinLink } from "@/lib/pages/learner";
import { loadRolePlayPreview } from "@/lib/pages/role-play-preview";
import { loadSessionDetail, loadSessionsList } from "@/lib/pages/sessions";
import { loadSpecResource } from "@/lib/pages/spec-resource";
import {
  agentDisplayName,
  listAgentContextRequired,
  listAgentContextUploads,
  listAgentNames,
  listAgentPersonas,
  listRunnableSpecs,
  listScenarioIntroVideos,
  listSpecSummaries,
  listUploads,
} from "@/lib/specs";
import { protectedProcedure, publicProcedure, studioProcedure, t } from "@/lib/trpc";
import { DEFAULT_TWIN_MINUTES, startableAgentSlugs } from "@/lib/twin-access";
import { avatarState, ownTwinPersona } from "@/lib/twin/avatar";

/**
 * Page loaders, mounted at /api/trpc under `page`: what each studio / learner page used to load while rendering on
 * the server, returned as the props its client component takes. Same queries and the same scoping: studio pages use
 * studioProcedure (admin, team), pages any member may open use protectedProcedure, learner-portal pages resolve the
 * org from the subdomain (publicProcedure). Twin and role-play pages read the twin / roleplay routers directly.
 */

const slugInput = z.object({ slug: z.string().min(1).max(200) });
const optional = z.string().max(200).optional();
const notFound = (): never => {
  throw new TRPCError({ code: "NOT_FOUND" });
};

export const pageRouter = t.router({
  // Twin pages (the twin router has the rest).
  ownTwinPersona: studioProcedure.query(async ({ ctx }) => (await ownTwinPersona(ctx.user.orgId))?.slug ?? null),
  twinDefaultMinutes: studioProcedure.query(() => DEFAULT_TWIN_MINUTES),

  /** Twin's brain. Knowledge (connectors + recent uploads) and voice/avatar are real; coaching style is fixed text for now. */
  twinBrain: studioProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const docs = { kb: { orgId } };
    const [notion, youtube, driveFiles, total, recent, avatar] = await Promise.all([
      db.notionConnection.findMany({ where: { orgId }, select: { id: true, workspaceName: true } }),
      db.youTubeConnection.findMany({ where: { orgId, status: "active" }, select: { id: true, channelTitle: true } }),
      // Drive has no saved connection (one-hour import sessions), so show what was imported from it.
      db.knowledgeDocument.count({ where: { ...docs, externalId: { startsWith: "google-drive:" } } }),
      db.knowledgeDocument.count({ where: docs }),
      db.knowledgeDocument.findMany({ where: docs, orderBy: { createdAt: "desc" }, take: 4, select: { id: true, title: true, slug: true } }),
      avatarState(orgId),
    ]);
    return {
      knowledge: {
        connectors: [
          ...notion.map((c) => ({ id: c.id, kind: "notion" as const, label: c.workspaceName || "Notion", status: "Connected" })),
          ...youtube.map((c) => ({ id: c.id, kind: "youtube" as const, label: c.channelTitle || "YouTube", status: "Connected" })),
          ...(driveFiles ? [{ id: "google-drive", kind: "drive" as const, label: "Google Drive", status: `${driveFiles} imported` }] : []),
        ],
        recent: recent.map((d) => ({ id: d.id, title: d.title || d.slug })),
        total,
      },
      avatar,
    };
  }),

  twinKnowledge: protectedProcedure.query(async ({ ctx }) => {
    const [initialDocs, initialStats] = await Promise.all([
      OrganizationKnowledgeService.getAllDocuments(ctx.user.orgId),
      OrganizationKnowledgeService.getStats(ctx.user.orgId),
    ]);
    return { initialDocs, initialStats };
  }),

  // Role plays (scenarios), their specs and calibration.
  agents: studioProcedure.query(({ ctx }) => listSpecSummaries("agents", ctx.user.orgId, "ROLEPLAY")),
  rolePlayPreview: studioProcedure.input(slugInput).query(({ ctx, input }) => loadRolePlayPreview(ctx.user.orgId, input.slug)),
  agentSpec: studioProcedure
    .input(z.object({ slug: z.string().min(1).max(200), version: optional, isNew: z.boolean() }))
    .query(({ ctx, input }) =>
      loadSpecResource({ orgId: ctx.user.orgId, type: "agents", slug: input.slug, requestedVersion: input.version, isNew: input.isNew }),
    ),

  /** The role play being calibrated and the persona it speaks as. */
  calibrationAgent: studioProcedure.input(slugInput).query(async ({ ctx, input }) => {
    const agent = await db.agent.findFirst({
      where: { slug: input.slug, orgId: ctx.user.orgId },
      select: { slug: true, name: true, persona: { select: { name: true } } },
    });
    if (!agent) return notFound();
    return { slug: agent.slug, scenarioName: agentDisplayName(agent.slug, agent.name), twinName: agent.persona.name };
  }),

  fidelity: studioProcedure.query(async ({ ctx }) => {
    const [report, scenarios] = await Promise.all([
      loadLatestFidelityReport(ctx.user.orgId),
      listSpecSummaries("agents", ctx.user.orgId),
    ]);
    const baseline = report?.scenarios[0]?.persona.slug
      ? await getPersonaBaseline(ctx.user.orgId, report.scenarios[0].persona.slug)
      : null;
    return { report, scenarios: scenarios.map(({ slug, name, version }) => ({ slug, name, version })), baseline };
  }),

  learners: studioProcedure.query(({ ctx }) => listLearners(ctx.user.orgId, "ROLEPLAY")),

  // Personas.
  personas: studioProcedure.query(({ ctx }) => listPersonas(ctx.user.orgId)),

  /** A persona's page; `spec` (and global personas) open the spec page with recordings and recorded style. */
  persona: studioProcedure
    .input(z.object({ slug: z.string().min(1).max(200), version: optional, spec: z.boolean() }))
    .query(async ({ ctx, input }) => {
      const persona = input.spec ? null : await getPersona(ctx.user.orgId, input.slug);
      if (persona) return { view: "persona" as const, item: persona };
      return loadSpecResource({ orgId: ctx.user.orgId, type: "personas", slug: input.slug, requestedVersion: input.version });
    }),

  personaEdit: studioProcedure.input(slugInput).query(async ({ ctx, input }) => {
    const item = await getPersona(ctx.user.orgId, input.slug);
    if (!item) return notFound();
    // A role-play persona picks its voice from the voice library; the trainer's own uses their cloned voice.
    return { item, voices: item.isOwn ? [] : await pickableVoices(ctx.user.orgId) };
  }),

  // Sessions.
  sessions: studioProcedure
    .input(z.object({ range: optional, scenario: optional, learner: optional }))
    .query(({ ctx, input }) => loadSessionsList(ctx.user.orgId, input, "ROLEPLAY")),
  session: studioProcedure.input(z.object({ id: z.string().min(1).max(200) })).query(({ ctx, input }) => loadSessionDetail(ctx.user.orgId, input.id)),

  /** Talk: the scenarios and twins this member can start, with what the session screen needs for each. */
  talk: protectedProcedure.input(z.object({ agent: optional })).query(async ({ ctx, input }) => {
    const orgId = ctx.user.orgId;
    const user = { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email };
    const [personas, runnable, contexts] = await Promise.all([
      listRunnableSpecs("personas", orgId),
      listRunnableSpecs("agents", orgId),
      listUploads(orgId, user.id),
    ]);
    // Learners see role plays plus only the twins assigned to them; admin and team see every agent.
    const agents = await startableAgentSlugs(orgId, user, runnable, isStudioRole(ctx.user.role));
    const initialAgent = input.agent && agents.includes(input.agent) ? input.agent : agents[0];
    const [agentNames, agentPersonas, introVideos, agentPhotos, agentContextRequired, agentContextUploads] = await Promise.all([
      listAgentNames(orgId, agents),
      listAgentPersonas(orgId, agents),
      listScenarioIntroVideos(orgId, agents),
      agentPhotoUrls(orgId, agents),
      listAgentContextRequired(orgId, agents),
      listAgentContextUploads(orgId, agents),
    ]);
    return {
      personas,
      agents,
      agentNames,
      initialAgent,
      agentPersonas,
      introVideos,
      agentPhotos,
      agentContextRequired,
      agentContextUploads,
      contexts: contexts.map((c) => ({ id: c.id, name: c.name, size: c.size })),
    };
  }),

  // Workspace pages any member may open.
  overview: protectedProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const [personas, agents, kbs, sessions] = await Promise.all([
      db.persona.count({ where: { orgId } }),
      db.agent.count({ where: { orgId } }),
      db.knowledgeBase.count({ where: { orgId } }),
      db.interviewSession.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          personaSlug: true,
          personaVersion: true,
          agentSlug: true,
          agentVersion: true,
          contextName: true,
          startedAt: true,
          createdAt: true,
          status: true,
        },
      }),
    ]);
    return { personas, agents, kbs, sessions };
  }),

  voices: protectedProcedure.query(async ({ ctx }) => {
    const voices = await db.voice.findMany({
      where: { OR: [{ orgId: ctx.user.orgId }, { orgId: null }] },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, kind: true, status: true, createdAt: true },
    });
    const rows = voices.map((voice) => ({ ...voice, createdAt: voice.createdAt.toISOString() }));
    return { mine: rows.filter((voice) => voice.kind === "cloned"), samples: rows.filter((voice) => voice.kind === "sample") };
  }),

  developer: protectedProcedure.query(async ({ ctx }) => {
    const canManageApiKeys = isStudioRole(ctx.user.role);
    const apiKeys = canManageApiKeys
      ? await db.apikey.findMany({
          where: { referenceId: ctx.user.orgId, configId: "default" },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, start: true, enabled: true, expiresAt: true, lastRequest: true, createdAt: true },
        })
      : [];
    return {
      canManageApiKeys,
      apiKeys: apiKeys.map((key) => ({
        ...key,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        lastRequest: key.lastRequest?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
      })),
    };
  }),

  settings: protectedProcedure.query(async ({ ctx }) => {
    const orgId = ctx.user.orgId;
    const studio = isStudioRole(ctx.user.role);
    const organization = await db.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, logo: true, websiteUrl: true, metadata: true },
    });
    // Team: studio only (admin, team). Everyone in the org plus pending invites; disabled members stay listed. Users
    // also lists people assigned a twin or role play by email who haven't joined yet (they join by opening their link).
    const team = studio
      ? await Promise.all([
          db.member.findMany({
            where: { organizationId: orgId },
            orderBy: { createdAt: "asc" },
            select: { id: true, userId: true, role: true, createdAt: true, disabledAt: true, user: { select: { name: true, email: true } } },
          }),
          db.invitation.findMany({
            where: { organizationId: orgId, status: "pending", expiresAt: { gt: new Date() } },
            orderBy: { createdAt: "desc" },
            select: { id: true, email: true, role: true, expiresAt: true },
          }),
          db.twinAssignment.findMany({
            where: { orgId, status: "active", userId: null },
            orderBy: { createdAt: "desc" },
            select: { recipientEmail: true, agent: { select: { name: true } } },
          }),
          db.rolePlayAssignment.findMany({
            where: { orgId, status: "pending", memberId: null },
            orderBy: { assignedAt: "desc" },
            select: { recipientEmail: true, deployment: { select: { agent: { select: { name: true } } } } },
          }),
        ])
      : null;
    return {
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      organization: { ...organization, accentColor: parseAccentColor(organization.metadata) },
      team: team
        ? {
            members: team[0].map(({ user, createdAt, disabledAt, ...member }) => ({
              ...member,
              name: user.name,
              email: user.email,
              createdAt: createdAt.toISOString(),
              disabledAt: disabledAt?.toISOString() ?? null,
            })),
            invitations: team[1].map((invitation) => ({ ...invitation, expiresAt: invitation.expiresAt.toISOString() })),
            awaiting: awaitingUsers({
              memberEmails: team[0].map((member) => member.user.email),
              invitedEmails: team[1].map((invitation) => invitation.email),
              assignments: [
                ...team[2].map((row) => ({ email: row.recipientEmail, title: row.agent.name })),
                ...team[3].map((row) => ({ email: row.recipientEmail, title: row.deployment.agent.name })),
              ],
            }),
          }
        : null,
    };
  }),

  // Learner portal (<org>.<base>): the org comes from the subdomain, visitors may not be signed in yet.
  sharedSession: publicProcedure.input(z.object({ code: z.string().min(1).max(200) })).query(({ input }) => loadSharedSession(input.code)),
  twinLink: publicProcedure.input(slugInput).query(({ input }) => loadTwinLink(input.slug)),
});
