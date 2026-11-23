import { randomBytes } from "node:crypto";
import { AppError, refusals } from "@/lib/errors";
import { getOrgBySlug } from "@/lib/org";
import { publicHostSlug, publicIpHash, publicRequestHost } from "@/lib/public-twin-request";
import { publicBot, publicSettingsOf, widgetSettingsOf, type PublicBot } from "@/lib/bots";
import { normalizeWidgetOrigin } from "@/lib/widget-settings";
import { readWidgetVisitor, widgetCredentialInvalid, widgetStartGrant, widgetVisitorToken } from "@/lib/widget-tokens";

export const widgetUnavailable = () => new AppError("widget_unavailable", "This twin is not available on this website.", 403);

/** The widget runs exactly when the bot's public calls are on and its deployment lists this website. */
export function assertWidgetAccess(bot: Pick<PublicBot, "deployment">, origin: string) {
  const settings = widgetSettingsOf(bot.deployment);
  if (!publicSettingsOf(bot.deployment).enabled || !settings.allowedOrigins.includes(origin)) throw widgetUnavailable();
  return settings;
}

/** The bot a widget names (its id, or an older snippet's twin id), checked for this website. */
export async function widgetAgent(orgId: string, agentId: string, parentOrigin: string) {
  const normalized = normalizeWidgetOrigin(parentOrigin);
  if (!normalized || normalized !== parentOrigin) throw widgetUnavailable();
  const bot = await publicBot(orgId, agentId);
  if (!bot) throw refusals.notFound();
  const settings = assertWidgetAccess(bot, parentOrigin);
  return { agent: bot, settings };
}

export async function widgetRequestOrg(request: Request) {
  const org = await getOrgBySlug(publicRequestHost(request));
  if (!org) throw refusals.notFound();
  return org;
}
export async function widgetPageOrg(request: Request) {
  const org = await getOrgBySlug(publicHostSlug(request.headers.get("host") ?? new URL(request.url).host));
  if (!org) throw refusals.notFound();
  return org;
}
export function widgetBearer(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer ([a-zA-Z0-9_.-]{1,2048})$/i)?.[1] ?? "";
}

export async function bootstrapWidget(request: Request, input: { agentId: string; parentOrigin: string; visitorToken?: string }) {
  const org = await widgetRequestOrg(request);
  await widgetAgent(org.id, input.agentId, input.parentOrigin);
  let visitorId = randomBytes(32).toString("hex");
  if (input.visitorToken) {
    const visitor = readWidgetVisitor(input.visitorToken);
    if (visitor.orgId !== org.id || visitor.parentOrigin !== input.parentOrigin) throw widgetCredentialInvalid();
    visitorId = visitor.visitorId;
  }
  const visitorScope = { orgId: org.id, visitorId, parentOrigin: input.parentOrigin };
  return {
    grant: widgetStartGrant({ ...visitorScope, agentId: input.agentId }),
    visitorToken: widgetVisitorToken(visitorScope),
  };
}

export const widgetRequestIp = (request: Request, orgId: string) => publicIpHash(orgId, request.headers);
