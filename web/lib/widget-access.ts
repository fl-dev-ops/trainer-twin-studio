import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { AppError, refusals } from "@/lib/errors";
import { getOrgBySlug } from "@/lib/org";
import { publicHostSlug, publicIpHash, publicRequestHost } from "@/lib/public-twin-request";
import { publicTwinSettings } from "@/lib/public-twin-settings";
import { normalizeWidgetOrigin, widgetSettings } from "@/lib/widget-settings";
import { readWidgetVisitor, widgetCredentialInvalid, widgetStartGrant, widgetVisitorToken } from "@/lib/widget-tokens";

export const widgetUnavailable = () => new AppError("widget_unavailable", "This twin is not available on this website.", 403);

export function assertWidgetAccess(data: unknown, origin: string) {
  const settings = widgetSettings(data);
  // The widget is on exactly when the twin is public and lists this website; the stored `enabled` flag is derived from
  // the list on save (lib/twin/manage), so older rows with websites but `enabled: false` are not consulted.
  if (!publicTwinSettings(data).enabled || !settings.allowedOrigins.includes(origin)) throw widgetUnavailable();
  return settings;
}

export async function widgetAgent(orgId: string, agentId: string, parentOrigin: string) {
  const normalized = normalizeWidgetOrigin(parentOrigin);
  if (!normalized || normalized !== parentOrigin) throw widgetUnavailable();
  const agent = await db.agent.findFirst({
    where: { id: agentId, orgId, kind: "TWIN", archivedAt: null },
    select: { id: true, orgId: true, name: true, data: true, personaId: true, persona: { select: { name: true } } },
  });
  if (!agent) throw refusals.notFound();
  const settings = assertWidgetAccess(agent.data, parentOrigin);
  return { agent, settings };
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
