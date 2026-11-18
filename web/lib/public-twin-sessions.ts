import { randomBytes, timingSafeEqual } from "node:crypto";
import { start } from "workflow/api";
import { db, withLock } from "@/lib/db";
import { AppError, refusals } from "@/lib/errors";
import { pausedReason } from "@/lib/billing/paused";
import { minutesLock } from "@/lib/minutes";
import { orgCredits } from "@/lib/org-credits";
import { publicTwinSettings, publicVisitorNameSchema } from "@/lib/public-twin-settings";
import { browserToken, initializeChatSession, runtimeToken, tokenHash } from "@/lib/interview-sessions";
import { getAgentConfigForAgent } from "@/lib/specs";
import { pinTwinSkills, TWIN_SOURCE } from "@/lib/twins";
import { initRuntimeState } from "@/lib/runtime/runtime";
import { connectVoice } from "@/lib/session-activation";
import { closeInterviewSession } from "@/lib/session-lifecycle";
import { closeLiveKitSession } from "@/lib/livekit";
import { publicCallDeadline } from "@/workflows/public-call-deadline";
import { assertWidgetAccess } from "@/lib/widget-access";
import { widgetCredentialInvalid } from "@/lib/widget-tokens";

export const PUBLIC_STARTS_PER_HOUR = 3;
export const PUBLIC_ORG_STARTS_PER_HOUR = 30;
export const PUBLIC_ORG_CONCURRENT_CALLS = 5;

export const publicCallRefusals = {
  unavailable: () => new AppError("public_twin_unavailable", "Public calls are not available for this twin.", 403),
  limited: () => new AppError("public_call_limit", "Too many public calls. Please try again later.", 429),
  busy: () => new AppError("public_call_busy", "A public call is already running. Please try again later.", 409),
};

export async function startPublicTwinSession(input: {
  orgId: string;
  agentId: string;
  visitorId: string;
  ipHash: string;
  name: string;
  embedOrigin?: string;
  grantExpiresAt?: number;
}) {
  const parsed = publicVisitorNameSchema.safeParse(input.name);
  if (!parsed.success) throw refusals.invalidInput(parsed.error.issues[0].message);
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, orgId: input.orgId, kind: "TWIN", archivedAt: null },
  });
  if (!agent) throw refusals.notFound();
  if (!publicTwinSettings(agent.data).enabled) throw publicCallRefusals.unavailable();
  if (input.embedOrigin) assertWidgetAccess(agent.data, input.embedOrigin);

  const config = await getAgentConfigForAgent(agent.id, input.orgId);
  if (!config || config.agent.version !== agent.version) throw new AppError("public_twin_changed", "This twin was updated. Please start again.", 409);
  const skills = (agent.data as { source?: string } | null)?.source === TWIN_SOURCE
    ? await pinTwinSkills(input.orgId, agent.personaId) : undefined;
  await orgCredits(input.orgId, { fresh: true });

  const session = await withLock([minutesLock(input.orgId)], async (tx) => {
    if (input.grantExpiresAt !== undefined && input.grantExpiresAt * 1000 <= Date.now()) throw widgetCredentialInvalid();
    // The same row lock is taken by settings/version writes, so disabling cannot race a new start.
    await tx.$queryRaw`SELECT 1 FROM "Agent" WHERE id = ${agent.id} FOR UPDATE`;
    const current = await tx.agent.findFirst({
      where: { id: agent.id, orgId: input.orgId, kind: "TWIN", archivedAt: null },
      select: { data: true, version: true },
    });
    if (!current || !publicTwinSettings(current.data).enabled) throw publicCallRefusals.unavailable();
    if (input.embedOrigin) assertWidgetAccess(current.data, input.embedOrigin);
    if (current.version !== agent.version) throw new AppError("public_twin_changed", "This twin was updated. Please start again.", 409);
    if (await pausedReason(input.orgId, "studio", tx)) throw publicCallRefusals.unavailable();
    const settings = publicTwinSettings(current.data);
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [recent, orgRecent, live] = await Promise.all([
      tx.interviewSession.count({
        where: { orgId: input.orgId, anonymousId: { not: null }, createdAt: { gte: since },
          OR: [{ anonymousId: input.visitorId }, { anonymousIpHash: input.ipHash }] },
      }),
      tx.interviewSession.count({ where: { orgId: input.orgId, anonymousId: { not: null }, createdAt: { gte: since } } }),
      tx.interviewSession.findMany({
        where: { orgId: input.orgId, anonymousId: { not: null }, status: { in: ["activating", "active"] } },
        select: { anonymousId: true, anonymousIpHash: true },
      }),
    ]);
    if (recent >= PUBLIC_STARTS_PER_HOUR || orgRecent >= PUBLIC_ORG_STARTS_PER_HOUR) throw publicCallRefusals.limited();
    if (live.length >= PUBLIC_ORG_CONCURRENT_CALLS || live.some((row) => row.anonymousId === input.visitorId || row.anonymousIpHash === input.ipHash)) {
      throw publicCallRefusals.busy();
    }
    const credits = await orgCredits(input.orgId, { tx });
    if (!credits.billed || credits.seconds < settings.maxSeconds) throw publicCallRefusals.unavailable();
    if (input.grantExpiresAt !== undefined && input.grantExpiresAt * 1000 <= Date.now()) throw widgetCredentialInvalid();
    return tx.interviewSession.create({
      data: {
        orgId: input.orgId, agentId: agent.id,
        anonymousId: input.visitorId, anonymousIpHash: input.ipHash, anonymousName: parsed.data,
        embedOrigin: input.embedOrigin ?? null,
        shareCode: randomBytes(18).toString("base64url"),
        activationKey: `public:${randomBytes(18).toString("base64url")}`,
        mode: "voice", status: "activating", startedAt: new Date(),
        allowedSeconds: settings.maxSeconds, chargesOrg: true,
        agentSlug: agent.slug, agentVersion: agent.version,
        personaSlug: config.persona.slug, personaVersion: config.persona.version,
        compiledSnapshot: JSON.parse(JSON.stringify({ ...config, ...(skills ? { twinSkills: skills } : {}) })),
        runtimeState: JSON.parse(JSON.stringify(initRuntimeState())),
      },
    });
  }, { timeout: 15_000, maxWait: 15_000 });

  const token = runtimeToken(session.id);
  let connectingVoice = false;
  try {
    // Public starts fail closed if durable cleanup cannot be scheduled.
    await start(publicCallDeadline, [session.id, new Date(session.startedAt!.getTime() + session.allowedSeconds! * 1000).toISOString()]);
    await initializeChatSession({ orgId: input.orgId, sessionId: session.id, mode: "voice" });
    const remaining = Math.max(0, session.allowedSeconds! - Math.ceil((Date.now() - session.startedAt!.getTime()) / 1000));
    if (!remaining) throw publicCallRefusals.unavailable();
    const activated = await db.interviewSession.updateMany({
      where: { id: session.id, status: "activating" },
      data: { status: "active", runtimeTokenHash: tokenHash(token) },
    });
    if (!activated.count) throw publicCallRefusals.unavailable();
    const opened = {
      id: session.id, agentSlug: session.agentSlug, status: "active", mode: "voice" as const,
      runtimeToken: browserToken(session.id), agentToken: token, secondsLeft: remaining,
      calibrationId: null,
      endsAt: session.startedAt!.getTime() + session.allowedSeconds! * 1000,
      serverTime: Date.now(),
    };
    connectingVoice = true;
    const voice = await connectVoice({
      orgId: input.orgId, userId: `visitor-${session.id}`, userName: parsed.data, mode: "voice",
    }, opened);
    const { agentToken: _agentToken, ...browserSession } = opened;
    void _agentToken;
    browserSession.secondsLeft = Math.max(0, session.allowedSeconds! - Math.ceil((Date.now() - session.startedAt!.getTime()) / 1000));
    browserSession.serverTime = Date.now();
    if (!browserSession.secondsLeft) throw publicCallRefusals.unavailable();
    return { session: browserSession, participantToken: voice.participantToken, room: voice.room };
  } catch (error) {
    await db.interviewSession.updateMany({
      where: { id: session.id, status: { in: ["activating", "active"] } },
      data: { status: "failed", endedAt: new Date(), runtimeTokenHash: null },
    });
    if (connectingVoice) await closeLiveKitSession({ room: session.id }, { strict: true });
    throw error;
  }
}

export async function endPublicTwinSession(input: { sessionId: string; orgId: string; visitorId: string; token: string }) {
  const row = await db.interviewSession.findFirst({
    where: { id: input.sessionId, orgId: input.orgId, anonymousId: input.visitorId, deletedAt: null },
    select: { id: true },
  });
  // End is idempotent, including after the agent or deadline already closed the call.
  if (!row || !validPublicSessionToken(row.id, input.token)) throw refusals.notFound();
  await closeInterviewSession(row.id, "abandoned");
}

export function validPublicSessionToken(sessionId: string, token: string) {
  const expected = Buffer.from(browserToken(sessionId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
