import { NextResponse } from "next/server";
import { getSessionOrg } from "@/lib/org";
import { createSessionRecord, endSessionRecord, listSessions } from "@/lib/specs";
import { db } from "@/lib/db";

export async function GET() {
  const org = await getSessionOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ sessions: await listSessions(org.id) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const required = ["personaSlug", "personaVersion", "agentSlug", "agentVersion", "domainSlug", "domainVersion"] as const;
  for (const key of required) {
    if (!body || typeof body[key] !== "string" && typeof body[key] !== "number") {
      return NextResponse.json({ error: `Missing ${key}` }, { status: 400 });
    }
  }
  // Called by the Pipecat agent (no user session): the persona pins the org.
  const persona = await db.persona.findUnique({
    where: { slug: String(body.personaSlug) },
    select: { orgId: true },
  });
  if (!persona?.orgId) {
    return NextResponse.json({ error: "Persona not found" }, { status: 404 });
  }

  // ponytail: learnerId stays null until the learner portal passes identity explicitly.
  const session = await createSessionRecord({
    orgId: persona.orgId,
    personaSlug: body.personaSlug,
    personaVersion: Number(body.personaVersion),
    agentSlug: body.agentSlug,
    agentVersion: Number(body.agentVersion),
    domainSlug: body.domainSlug,
    domainVersion: Number(body.domainVersion),
    contextName: body.contextName,
  });
  return NextResponse.json({ session });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.id || !["completed", "abandoned"].includes(body.status)) {
    return NextResponse.json({ error: "id and status are required" }, { status: 400 });
  }
  try {
    await endSessionRecord(body.id, body.status);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
