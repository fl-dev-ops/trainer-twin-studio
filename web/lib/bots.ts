import { randomBytes } from "node:crypto";
import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { refusals } from "@/lib/errors";
import { DEFAULT_PUBLIC_CALL_SECONDS, PUBLIC_CALL_DURATIONS, publicTwinSettingsSchema, type PublicTwinSettings } from "@/lib/public-twin-settings";
import { widgetSettingsSchema, type WidgetSettings } from "@/lib/widget-settings";
import { setAgentPersonas } from "@/lib/agent-personas";
import { setSupportingSkills } from "@/lib/agent-skills";

/**
 * Bots (specs/agents.md): their own module, like twins and role plays. A BOT agent speaks as exactly one persona (the
 * trainer's own or a custom one), behaves by its purpose (data.objective; later its own `bot` SKILL.md), and draws on
 * the supporting skills chosen for it (AgentSkill). Signed-out visitors reach it through its one public Deployment
 * (channel "public"): status = public calls on, maxCallSeconds, the allowed websites, and the widget's look.
 */

export const BOT_SOURCE = "bot";
export const PUBLIC_CHANNEL = "public";
const DEFAULT_WELCOME = "Talk to my AI twin";
const DEFAULT_ACCENT = "#111111";

const deploymentSelect = {
  id: true, status: true, maxCallSeconds: true, allowedOrigins: true, config: true, publicKey: true,
} satisfies Prisma.DeploymentSelect;
const botSelect = {
  id: true, orgId: true, slug: true, name: true, version: true, personaId: true, data: true, archivedAt: true,
  persona: { select: { id: true, slug: true, name: true } },
  deployments: { where: { channel: PUBLIC_CHANNEL }, select: deploymentSelect, take: 1 },
  supportingSkills: {
    orderBy: { position: "asc" },
    select: { active: true, skill: { select: { id: true, name: true, ownerSlug: true } } },
  },
} satisfies Prisma.AgentSelect;

type BotRow = Prisma.AgentGetPayload<{ select: typeof botSelect }>;
type DeploymentRow = BotRow["deployments"][number];
export type PublicBot = Omit<BotRow, "deployments"> & { deployment: DeploymentRow | null };

function shape(row: BotRow | null): PublicBot | null {
  if (!row) return null;
  const { deployments, ...bot } = row;
  return { ...bot, deployment: deployments[0] ?? null };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Public call settings, in the shape the bot page edits. No deployment: off, default length. */
export function publicSettingsOf(deployment: Pick<DeploymentRow, "status" | "maxCallSeconds"> | null): PublicTwinSettings {
  const seconds = PUBLIC_CALL_DURATIONS.find((value) => value === deployment?.maxCallSeconds) ?? DEFAULT_PUBLIC_CALL_SECONDS;
  return { enabled: deployment?.status === "active", maxSeconds: seconds };
}

/** Widget settings: on exactly when it lists a website (public calls must also be on to start one). */
export function widgetSettingsOf(deployment: Pick<DeploymentRow, "allowedOrigins" | "config"> | null): WidgetSettings {
  const origins = Array.isArray(deployment?.allowedOrigins)
    ? deployment.allowedOrigins.filter((value): value is string => typeof value === "string") : [];
  const config = record(deployment?.config);
  return {
    enabled: origins.length > 0,
    allowedOrigins: origins,
    welcome: typeof config.welcome === "string" && config.welcome ? config.welcome : DEFAULT_WELCOME,
    accentColor: typeof config.accentColor === "string" && config.accentColor ? config.accentColor : DEFAULT_ACCENT,
  };
}

/** A live bot by its slug (the bot page). */
export async function botBySlug(orgId: string, slug: string, client: Prisma.TransactionClient = db) {
  return shape(await client.agent.findFirst({ where: { orgId, slug, kind: "BOT", archivedAt: null }, select: botSelect }));
}

/** The live bot a public request names (its id: the widget snippet's data-twin-id). */
export async function publicBot(orgId: string, agentId: string, client: Prisma.TransactionClient = db) {
  return shape(await client.agent.findFirst({ where: { id: agentId, orgId, kind: "BOT", archivedAt: null }, select: botSelect }));
}

/** Every live bot of the org, oldest first. */
export async function listBots(orgId: string, client: Prisma.TransactionClient = db) {
  const rows = await client.agent.findMany({ where: { orgId, kind: "BOT", archivedAt: null }, orderBy: { createdAt: "asc" }, select: botSelect });
  return rows.map((row) => shape(row)!);
}

const slugify = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "bot";

/**
 * A new bot: one persona (any of the org's, or a global one), its name and purpose, and a public deployment with calls
 * off and no websites. Supporting skills are chosen afterwards.
 */
export async function createBot(orgId: string, input: { personaId: string; name: string; objective: string }, tx: Prisma.TransactionClient) {
  const [org, persona] = await Promise.all([
    tx.organization.findUnique({ where: { id: orgId }, select: { slug: true } }),
    tx.persona.findFirst({ where: { id: input.personaId, OR: [{ orgId }, { orgId: null }] }, select: { id: true } }),
  ]);
  if (!org || !persona) throw refusals.notFound();
  const base = `${org.slug}-${slugify(input.name)}`;
  let slug = base;
  for (let n = 2; await tx.agent.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${base}-${n}`;
  const bot = await tx.agent.create({
    data: {
      orgId, slug, name: input.name, version: 1, personaId: persona.id, kind: "BOT",
      data: { id: slug, name: input.name, source: BOT_SOURCE, objective: input.objective, config: { context: { mode: "none", required: false } } },
    },
    select: { id: true },
  });
  await tx.deployment.create({
    data: {
      orgId, agentId: bot.id, channel: PUBLIC_CHANNEL, publicKey: `pub_${randomBytes(16).toString("hex")}`,
      allowedModes: "voice", allowedOrigins: [], status: "disabled", maxCallSeconds: DEFAULT_PUBLIC_CALL_SECONDS,
      config: { welcome: DEFAULT_WELCOME, accentColor: DEFAULT_ACCENT },
    },
  });
  return botBySlug(orgId, slug, tx);
}

export type BotPublicPatch = {
  publicAccess?: Partial<PublicTwinSettings>;
  widget?: Partial<Pick<WidgetSettings, "allowedOrigins" | "welcome" | "accentColor">>;
};

/** Saves a bot's public call and widget settings onto its deployment, normalized like every save. */
export async function saveBotPublic(bot: PublicBot, patch: BotPublicPatch, tx: Prisma.TransactionClient) {
  if (!bot.deployment) return bot;
  const access = publicTwinSettingsSchema.parse({ ...publicSettingsOf(bot.deployment), ...patch.publicAccess });
  // Trimmed welcome, exact lower-case origins, deduplicated.
  const merged = { ...widgetSettingsOf(bot.deployment), ...patch.widget };
  const parsed = widgetSettingsSchema.safeParse({ ...merged, enabled: merged.allowedOrigins.length > 0 });
  if (!parsed.success) throw refusals.invalidInput(parsed.error.issues[0].message);
  const widget = parsed.data;
  await tx.deployment.update({
    where: { id: bot.deployment.id },
    data: {
      status: access.enabled ? "active" : "disabled",
      maxCallSeconds: access.maxSeconds,
      allowedOrigins: widget.allowedOrigins,
      config: { welcome: widget.welcome, accentColor: widget.accentColor },
    },
  });
  return botBySlug(bot.orgId!, bot.slug, tx);
}

/** A bot's name, purpose and persona: a new bot version (the old one kept as history, like any agent edit). */
export async function saveBotDetails(bot: PublicBot, patch: { name?: string; objective?: string; personaId?: string }, tx: Prisma.TransactionClient) {
  const data = record(bot.data);
  const name = patch.name ?? bot.name;
  const next = { ...data, name, objective: patch.objective ?? data.objective };
  const personaChanged = patch.personaId !== undefined && patch.personaId !== bot.personaId;
  if (name === bot.name && next.objective === data.objective && !personaChanged) return bot;
  if (personaChanged) {
    const persona = await tx.persona.findFirst({ where: { id: patch.personaId, OR: [{ orgId: bot.orgId }, { orgId: null }] }, select: { id: true } });
    if (!persona) throw refusals.notFound();
    await setAgentPersonas(bot.id, [{ personaId: persona.id, active: true }], tx);
  }
  await tx.specVersion.create({
    data: { entityType: "agents", entitySlug: bot.slug, version: bot.version, data: JSON.parse(JSON.stringify(bot.data ?? {})), orgId: bot.orgId },
  });
  await tx.agent.update({ where: { id: bot.id }, data: { name, version: bot.version + 1, data: JSON.parse(JSON.stringify(next)) } });
  return botBySlug(bot.orgId!, bot.slug, tx);
}

/** A bot's supporting skills, in order, each switchable. Calls in progress keep the skills they started with. */
export async function saveBotSkills(bot: PublicBot, skills: { skillId: string; active: boolean }[], tx: Prisma.TransactionClient) {
  await setSupportingSkills(bot.orgId!, bot.id, skills, tx);
  return botBySlug(bot.orgId!, bot.slug, tx);
}
