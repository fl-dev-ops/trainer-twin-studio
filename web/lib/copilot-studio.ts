import { resolveUpload, UploadError } from "@/lib/uploads";
import { z } from "zod";
import { toolSettings } from "@/lib/agent-tools";
import { beforeSettings } from "@/lib/context-upload";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";
import { updateRoleplay } from "@/lib/roleplay/manage";
import { inviteToRoleplay } from "@/lib/roleplay/invites";
import { roleplayBuilderFrom } from "@/lib/roleplay/skill";
import { getObjectText } from "@/lib/s3";
import { ROLEPLAY_SOURCE, ScenarioIngestError, TWIN_SKILL_SOURCE } from "@/lib/scenario-ingest";
import { accessUntilSchema, assignTwinAndInvite, listTwinAssignments } from "@/lib/twin-access";
import { updateTwin } from "@/lib/twin/manage";
import { TWIN_SOURCE } from "@/lib/twins";

/**
 * What the copilot may read and change in the studio, for one org (plans/copilot-v2.md). Twins, twin skills and role
 * plays: read, change settings, archive / restore (soft delete). Learners: invite only. Never studio members, never a
 * hard delete. The route (/api/internal/copilot-studio) authenticates the copilot and passes the org and acting user.
 */

const slug = z.string().trim().min(1).max(200);
const emails = z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(100);
const before = z.object({
  preScreenshare: z.boolean(), preUpload: z.boolean(), duringUpload: z.boolean(),
  uploadTitle: z.string().trim().max(80), uploadInstruction: z.string().trim().max(300),
}).partial().strict();
const tools = z.object({ canvas: z.boolean(), codeEditor: z.boolean(), preview: z.boolean(), choice: z.boolean() }).partial().strict();

export const copilotStudioInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("context") }).strict(),
  // kind: the copilot's list_twins / list_roleplays and get_twin / get_roleplay read only their own module.
  z.object({ action: z.literal("list"), kind: z.enum(["twin", "roleplay"]).optional(), includeArchived: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("get"), slug, kind: z.enum(["twin", "roleplay"]).optional() }).strict(),
  z.object({ action: z.literal("getSkill"), slug, version: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal("listKnowledge") }).strict(),
  // The copilot channel's fetchFile (trainertwin-upload://<id>): a file this trainer attached in a copilot chat.
  z.object({ action: z.literal("resolveUpload"), documentId: z.string().trim().min(1).max(120) }).strict(),
  z.object({
    action: z.literal("updateTwin"), slug,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    settings: before.optional(),
  }).strict(),
  z.object({
    action: z.literal("updateRoleplay"), slug,
    // Builder fields (validated whole by the builder schema after merging).
    builder: z.record(z.string(), z.unknown()).optional(),
    before: before.optional(),
    tools: tools.optional(),
  }).strict(),
  z.object({
    action: z.literal("inviteLearners"), slug, emails,
    minutes: z.number().int().min(1).max(10_000).optional(),
    accessUntil: accessUntilSchema,
  }).strict(),
  z.object({ action: z.literal("archive"), slug }).strict(),
  z.object({ action: z.literal("restore"), slug }).strict(),
]);
export type CopilotStudioInput = z.infer<typeof copilotStudioInput>;
export type Actor = { org: { id: string; slug: string }; user: { id: string; name: string } };

/** What runCopilotStudio talks to; tests pass fakes instead of stubbing modules. */
const defaultDeps = { db, getObjectText, assignTwinAndInvite, listTwinAssignments, inviteToRoleplay, updateTwin, updateRoleplay, resolveUpload };
export type CopilotStudioDeps = typeof defaultDeps;

const asRecord = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** What an agent is, in the copilot's words. */
function kindOf(agent: { kind: string; data: unknown }) {
  const source = asRecord(agent.data).source;
  if (agent.kind === "TWIN") return source === TWIN_SOURCE ? "main-twin" : source === TWIN_SKILL_SOURCE ? "twin-skill" : "twin-skill-legacy";
  return source === ROLEPLAY_SOURCE ? "roleplay-builder" : "roleplay-recordings";
}

async function findAgent(d: CopilotStudioDeps, orgId: string, agentSlug: string, opts: { archived?: boolean } = {}) {
  const agent = await d.db.agent.findFirst({
    where: { orgId, slug: agentSlug, ...(opts.archived === undefined ? {} : { archivedAt: opts.archived ? { not: null } : null }) },
    select: { id: true, slug: true, name: true, kind: true, version: true, data: true, archivedAt: true, updatedAt: true },
  });
  if (!agent) throw new ScenarioIngestError(`"${agentSlug}" was not found${opts.archived ? " among archived items" : ""}`, 404);
  return agent;
}

/** Emails of the org's studio members (admin / team): the copilot invites learners only. */
async function studioMemberEmails(d: CopilotStudioDeps, orgId: string, list: string[]) {
  const members = await d.db.member.findMany({
    where: { organizationId: orgId, user: { email: { in: list } } },
    select: { role: true, user: { select: { email: true } } },
  });
  return new Set(members.filter((member) => isStudioRole(member.role)).map((member) => member.user.email.toLowerCase()));
}

export async function runCopilotStudio(actor: Actor, input: CopilotStudioInput, d: CopilotStudioDeps = defaultDeps) {
  const orgId = actor.org.id;
  switch (input.action) {
    case "context": {
      // Who the copilot works for: the org and its trainers' own personas (the USER / persona of the skill tools).
      const personas = await d.db.persona.findMany({ where: { orgId, isOwn: true }, orderBy: { createdAt: "asc" }, select: { slug: true, name: true } });
      return { org: actor.org.slug, trainer: actor.user.name, personas };
    }

    case "list": {
      const agents = await d.db.agent.findMany({
        where: {
          orgId,
          ...(input.kind ? { kind: input.kind === "twin" ? "TWIN" : "ROLEPLAY" } : {}),
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
        select: { slug: true, name: true, kind: true, version: true, data: true, archivedAt: true, updatedAt: true },
      });
      return {
        items: agents.map((agent) => ({
          slug: agent.slug,
          name: agent.name,
          kind: kindOf(agent),
          // The twin-creator / roleplay-creator id a skill update must keep.
          skillId: text(asRecord(asRecord(agent.data).scenario).skill) ?? text(asRecord(asRecord(agent.data).scenario).scenario),
          version: agent.version,
          description: text(asRecord(agent.data).objective),
          archived: agent.archivedAt !== null,
          updatedAt: agent.updatedAt.toISOString(),
        })),
      };
    }

    case "get": {
      const agent = await findAgent(d, orgId, input.slug);
      if (input.kind && (agent.kind === "TWIN") !== (input.kind === "twin")) {
        throw new ScenarioIngestError(`"${input.slug}" is a ${agent.kind === "TWIN" ? "twin" : "role play"}, not a ${input.kind === "twin" ? "twin" : "role play"}`, 400);
      }
      const kind = kindOf(agent);
      const base = {
        slug: agent.slug, name: agent.name, kind, version: agent.version, archived: agent.archivedAt !== null,
        description: text(asRecord(agent.data).objective), settings: beforeSettings(agent.data),
      };
      if (agent.kind === "TWIN") {
        const learners = await d.listTwinAssignments(orgId, agent.id);
        return {
          ...base,
          learners: learners.map((row) => ({ email: row.recipientEmail, status: row.status, minutes: row.minutesLimit, minutesUsed: row.minutesUsed })),
        };
      }
      const invites = await d.db.rolePlayAssignment.findMany({
        where: { orgId, deployment: { agentId: agent.id } },
        select: { recipientEmail: true, status: true },
      });
      return {
        ...base,
        tools: toolSettings(agent.data),
        builder: kind === "roleplay-builder" ? roleplayBuilderFrom(agent.data) : null,
        learners: invites.map((row) => ({ email: row.recipientEmail, status: row.status })),
      };
    }

    case "getSkill": {
      // A published skill package (twin skill or role play): the baseline for an update, or an older version to restore.
      const agent = await findAgent(d, orgId, input.slug);
      const version = input.version ?? agent.version;
      const data = version === agent.version
        ? asRecord(agent.data)
        : asRecord((await d.db.specVersion.findFirst({ where: { orgId, entityType: "agents", entitySlug: agent.slug, version }, select: { data: true } }))?.data);
      const artifacts = text(data.artifacts);
      if (!artifacts || typeof data.skill !== "string") throw new ScenarioIngestError(`"${agent.slug}" v${version} has no published skill files`, 404);
      const manifestFile = agent.kind === "TWIN" ? "skill.json" : "scenario.json";
      const read = (file: string) => d.getObjectText(`${artifacts}/${file}`).catch(() => null);
      const [manifest, items, patterns] = await Promise.all([read(manifestFile), read("items.json"), read("patterns.md")]);
      const versions = await d.db.specVersion.findMany({
        where: { orgId, entityType: "agents", entitySlug: agent.slug },
        orderBy: { version: "desc" },
        select: { version: true, createdAt: true },
      });
      return {
        slug: agent.slug,
        kind: kindOf(agent),
        name: agent.name,
        version,
        currentVersion: agent.version,
        versions: [{ version: agent.version, current: true }, ...versions.map((row) => ({ version: row.version, savedAt: row.createdAt.toISOString() }))],
        skill: data.skill,
        manifest: manifest ? JSON.parse(manifest) : asRecord(data.scenario),
        items: items ? JSON.parse(items) : [],
        patterns,
      };
    }

    case "listKnowledge": {
      const docs = await d.db.knowledgeDocument.findMany({
        where: { kb: { orgId }, status: { not: "failed" } },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, ext: true, createdAt: true },
      });
      return { docs: docs.map((doc) => ({ id: doc.id, title: doc.title, ext: doc.ext, addedAt: doc.createdAt.toISOString() })) };
    }

    case "resolveUpload": {
      try {
        // The copilot's model reads images, not PDFs: a PDF comes as its text.
        return await d.resolveUpload({ orgId, id: input.documentId, ownerUserId: actor.user.id, pdfAsText: true });
      } catch (error) {
        if (error instanceof UploadError) throw new ScenarioIngestError(error.message, error.status);
        throw error;
      }
    }

    case "updateTwin":
      await findAgent(d, orgId, input.slug, { archived: false });
      return d.updateTwin(orgId, input.slug, { name: input.name, description: input.description, settings: input.settings });

    case "updateRoleplay":
      return d.updateRoleplay(orgId, input.slug, { builder: input.builder as never, before: input.before, tools: input.tools });

    case "inviteLearners": {
      const agent = await findAgent(d, orgId, input.slug, { archived: false });
      const staff = await studioMemberEmails(d, orgId, input.emails);
      const learners = input.emails.filter((email) => !staff.has(email));
      const refused = input.emails.filter((email) => staff.has(email));
      if (!learners.length) return { invited: 0, refused, reason: "Studio members (admin / team) are not invited as learners." };
      if (agent.kind === "TWIN") {
        if (!input.minutes) throw new ScenarioIngestError("Twin invites need minutes (each learner's practice budget)", 400);
        const result = await d.assignTwinAndInvite({
          org: actor.org, by: actor.user, agent: { id: agent.id, name: agent.name },
          emails: learners, minutes: input.minutes, accessUntil: input.accessUntil,
        });
        return { ...result, refused };
      }
      return { ...(await d.inviteToRoleplay({ org: actor.org, by: actor.user, agent, emails: learners })), refused };
    }

    case "archive": {
      const agent = await findAgent(d, orgId, input.slug, { archived: false });
      if (kindOf(agent) === "main-twin") throw new ScenarioIngestError("The main twin can't be archived; archive its skills instead", 400);
      await d.db.agent.update({ where: { id: agent.id }, data: { archivedAt: new Date() } });
      return { slug: agent.slug, name: agent.name, archived: true, restore: "restore with the same slug" };
    }

    case "restore": {
      const agent = await findAgent(d, orgId, input.slug, { archived: true });
      await d.db.agent.update({ where: { id: agent.id }, data: { archivedAt: null } });
      return { slug: agent.slug, name: agent.name, archived: false };
    }
  }
}
