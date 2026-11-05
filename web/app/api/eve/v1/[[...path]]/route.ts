import { getSessionCookie } from "better-auth/cookies";
import { db } from "@/lib/db";
import { getTrainerOrg, type TrainerOrg } from "@/lib/org";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ path?: string[] }> };

// One copilot turn makes several proxied requests (send, stream, reconnects): reuse the signed-in org briefly. Keyed by
// the session cookie AND the tab's pinned org (lib/org-pin.ts): one person in two orgs gets each tab's own org.
// shortcut: per-instance memory, so a role change or disable reaches the copilot proxy within ORG_TTL_MS; use a shared cache if that matters.
const ORG_TTL_MS = 30_000;
/** The tab's pinned org (lib/org-pin.ts ORG_PIN_HEADER, multi-org); absent before that lands, so the key is the cookie. */
const ORG_PIN_HEADER = "x-trainertwin-org";
const orgCache = new Map<string, { org: TrainerOrg; until: number }>();
async function trainerOrgFor(request: Request) {
  const token = getSessionCookie(request);
  const key = token ? `${token}:${request.headers.get(ORG_PIN_HEADER) ?? ""}` : null;
  const hit = key ? orgCache.get(key) : undefined;
  if (hit && hit.until > Date.now()) return hit.org;
  const org = await getTrainerOrg();
  if (key && org) {
    if (orgCache.size > 1000) orgCache.clear();
    orgCache.set(key, { org, until: Date.now() + ORG_TTL_MS });
  }
  return org;
}

const notFound = () => Response.json({ ok: false, error: "Session not found." }, { status: 404 });

/**
 * eve has no per-session access control (anyone the route admits reaches any session id), so the proxy owns it: a
 * session belongs to the user and org that created it (copilot_session), and only they reach it. Another org of the
 * same person, or another person, gets eve's own "not found".
 */
async function ownsSession(org: TrainerOrg, sessionId: string) {
  const row = await db.copilotSession.findUnique({ where: { sessionId }, select: { orgId: true, userId: true } });
  return row !== null && row.orgId === org.id && row.userId === org.user.id;
}

/** The first words of the trainer's first message, as the conversation's title (tags from the composer left out). */
function titleOf(body: ArrayBuffer | undefined) {
  if (!body?.byteLength) return "New conversation";
  try {
    const message = (JSON.parse(new TextDecoder().decode(body)) as { message?: unknown }).message;
    const text = typeof message === "string"
      ? message
      : Array.isArray(message) ? message.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join(" ") : "";
    const plain = text.replace(/<use-skill[^>]*\/>|<selected-files>[\s\S]*?<\/selected-files>/g, " ").replace(/\s+/g, " ").trim();
    return plain.slice(0, 120) || "New conversation";
  } catch {
    return "New conversation";
  }
}

async function proxy(request: Request, { params }: Params) {
  const origin = process.env.EVE_ORIGIN;
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!origin || !secret) return Response.json({ error: "Copilot is not configured" }, { status: 503 });
  const org = await trainerOrgFor(request);
  if (!org) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const segments = (await params).path ?? [];
  // session            -> create (recorded below)
  // session/<id>[/...] -> only its owner
  const sessionId = segments[0] === "session" && segments[1] ? segments[1] : null;
  const creating = segments[0] === "session" && segments.length === 1 && request.method === "POST";
  if (sessionId && !(await ownsSession(org, sessionId))) return notFound();

  const path = segments.map(encodeURIComponent).join("/");
  const target = new URL(`/eve/v1/${path}`, origin);
  target.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  // The authenticated organization becomes Eve's durable session principal.
  headers.set("authorization", `Basic ${Buffer.from(`${org.id}:${secret}`).toString("base64")}`);
  // Signed-in trainer for usage attribution. set() overwrites any client-sent value; copilot only
  // trusts it alongside the Basic secret above.
  headers.set("x-trainertwin-user-id", org.user.id);
  for (const name of ["cookie", "host", "content-length", "accept-encoding", ORG_PIN_HEADER]) headers.delete(name);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
    });
    const responseHeaders = new Headers(response.headers);
    for (const name of ["content-encoding", "content-length", "set-cookie", "transfer-encoding"]) responseHeaders.delete(name);

    if (creating && response.ok) {
      // A small JSON answer ({ ok, sessionId, status }): record the owner before the browser can use the id.
      const text = await response.text();
      const created = (() => {
        try {
          return JSON.parse(text) as { sessionId?: unknown };
        } catch {
          return null;
        }
      })();
      if (typeof created?.sessionId !== "string") return Response.json({ error: "Copilot did not return a session" }, { status: 502 });
      await db.copilotSession.upsert({
        where: { sessionId: created.sessionId },
        create: { sessionId: created.sessionId, orgId: org.id, userId: org.user.id, title: titleOf(body) },
        update: {},
      });
      // Someone else's existing session (operationId reuse) is still not theirs.
      if (!(await ownsSession(org, created.sessionId))) return notFound();
      return new Response(text, { status: response.status, headers: responseHeaders });
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: "Copilot is unavailable" }, { status: 502 });
  }
}

export function GET(request: Request, context: Params) {
  return proxy(request, context);
}

export function POST(request: Request, context: Params) {
  return proxy(request, context);
}
