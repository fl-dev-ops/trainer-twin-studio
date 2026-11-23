import { randomBytes } from "node:crypto";
import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { refusals } from "@/lib/errors";
import { DEFAULT_PUBLIC_CALL_SECONDS, PUBLIC_CALL_DURATIONS, publicTwinSettingsSchema, type PublicTwinSettings } from "@/lib/public-twin-settings";
import { widgetSettingsSchema, type WidgetSettings } from "@/lib/widget-settings";

/**
 * Bots: the public side of a trainer's twin (specs/public-twins.md). A BOT agent shares the twin's persona and skills
 * but has its own row, name and purpose, so changing the twin for learners never silently changes what website visitors
 * get. A twin can have several bots (say, one per website); data.twinId links each to its twin, and the oldest one
 * answers the twin's own public link. Each bot's public link and widget settings live on its one Deployment (channel
 * "public"): status = public calls on, maxCallSeconds, the allowed websites, and the widget's look in config.
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
  persona: { select: { name: true } },
  deployments: { where: { channel: PUBLIC_CHANNEL }, select: deploymentSelect, take: 1 },
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

/** Public call settings, in the shape the twin settings page edits. No deployment: off, default length. */
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

/** The live bot made for this twin, if any. */
export async function botForTwin(orgId: string, twinId: string, client: Prisma.TransactionClient = db) {
  return shape(await client.agent.findFirst({
    where: { orgId, kind: "BOT", archivedAt: null, data: { path: ["twinId"], equals: twinId } },
    orderBy: { createdAt: "asc" },
    select: botSelect,
  }));
}

/**
 * The live bot a public request names: its own id, or (links and widget snippets made before bots existed) the id of
 * the twin it was made for.
 */
export async function publicBot(orgId: string, agentId: string, client: Prisma.TransactionClient = db) {
  const own = await client.agent.findFirst({ where: { id: agentId, orgId, kind: "BOT", archivedAt: null }, select: botSelect });
  const bot = own ? shape(own) : await botForTwin(orgId, agentId, client);
  if (!bot) return null;
  // Archiving the twin takes its public side down too.
  const twinId = record(bot.data).twinId;
  if (typeof twinId === "string" && !await client.agent.findFirst({ where: { id: twinId, orgId, archivedAt: null }, select: { id: true } })) return null;
  return bot;
}

/** A live bot by its slug (the Website bot page), with its twin's name. */
export async function botBySlug(orgId: string, slug: string, client: Prisma.TransactionClient = db) {
  return shape(await client.agent.findFirst({ where: { orgId, slug, kind: "BOT", archivedAt: null }, select: botSelect }));
}

/** Every live bot of the org, oldest first. */
export async function listBots(orgId: string, client: Prisma.TransactionClient = db) {
  const rows = await client.agent.findMany({ where: { orgId, kind: "BOT", archivedAt: null }, orderBy: { createdAt: "asc" }, select: botSelect });
  return rows.map((row) => shape(row)!);
}

/** The twin a bot speaks as (data.twinId). */
export const twinIdOf = (bot: Pick<PublicBot, "data">) => {
  const id = record(bot.data).twinId;
  return typeof id === "string" ? id : null;
};

/**
 * A new bot for a twin: the twin's persona, voice and skills, its own name and purpose (the twin's description unless
 * given), and a public deployment with calls off and no websites.
 */
export async function createBot(orgId: string, twinId: string, details: { name?: string; objective?: string }, tx: Prisma.TransactionClient) {
  const twin = await tx.agent.findFirst({
    where: { id: twinId, orgId, kind: "TWIN", archivedAt: null },
    select: { id: true, slug: true, name: true, visibility: true, personaId: true, data: true },
  });
  if (!twin) return null;
  let slug = `${twin.slug}-bot`;
  for (let n = 2; await tx.agent.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${twin.slug}-bot-${n}`;
  const data = record(twin.data);
  const name = details.name ?? twin.name;
  const bot = await tx.agent.create({
    data: {
      orgId, slug, name, version: 1, personaId: twin.personaId, kind: "BOT", visibility: twin.visibility,
      data: JSON.parse(JSON.stringify({
        id: slug, name, source: BOT_SOURCE, twinId: twin.id, objective: details.objective ?? data.objective, config: data.config,
      })),
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

/** The twin's first bot, created the first time its public settings are saved through the twin. */
export async function ensureBotForTwin(orgId: string, twinId: string, tx: Prisma.TransactionClient) {
  return (await botForTwin(orgId, twinId, tx)) ?? createBot(orgId, twinId, {}, tx);
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

/** A bot's own name and purpose (what its visitors get), versioned on the bot only: the twin is untouched. */
export async function saveBotOwnDetails(bot: PublicBot, patch: { name?: string; objective?: string }, tx: Prisma.TransactionClient) {
  const data = record(bot.data);
  const name = patch.name ?? bot.name;
  const next = { ...data, name, objective: patch.objective ?? data.objective };
  if (name === bot.name && next.objective === data.objective) return bot;
  await tx.specVersion.create({
    data: { entityType: "agents", entitySlug: bot.slug, version: bot.version, data: JSON.parse(JSON.stringify(bot.data ?? {})), orgId: bot.orgId },
  });
  await tx.agent.update({ where: { id: bot.id }, data: { name, version: bot.version + 1, data: JSON.parse(JSON.stringify(next)) } });
  return botBySlug(bot.orgId!, bot.slug, tx);
}

/** Saves public settings onto the twin's first bot (creating it if needed): the twin settings API and the copilot. */
export async function saveBotPublicSettings(orgId: string, twinId: string, patch: BotPublicPatch, tx: Prisma.TransactionClient) {
  const bot = await ensureBotForTwin(orgId, twinId, tx);
  return bot ? saveBotPublic(bot, patch, tx) : null;
}

/** The twin's first bot's name and purpose (creating it if needed). */
export async function saveBotDetails(orgId: string, twinId: string, patch: { name?: string; objective?: string }, tx: Prisma.TransactionClient) {
  const bot = await ensureBotForTwin(orgId, twinId, tx);
  return bot ? saveBotOwnDetails(bot, patch, tx) : null;
}
