import type { Actor } from "@/lib/copilot-studio";
import { db } from "@/lib/db";
import { isStudioRole } from "@/lib/org";
import { orgPerson } from "@/lib/org-people";
import { ingestAuthorized } from "@/lib/scenario-ingest";

export async function copilotActor(request: Request): Promise<Actor | Response> {
  if (!ingestAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  const userId = request.headers.get("x-trainertwin-user-id")?.trim();
  if (!orgId || !userId) return Response.json({ error: "Organization and user are required" }, { status: 400 });
  const person = await orgPerson(orgId, { userId });
  if (!person || person.disabled || !isStudioRole(person.role)) {
    return Response.json({ error: "Only enabled studio members can use the copilot" }, { status: 403 });
  }
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  if (!org) return Response.json({ error: "Organization not found" }, { status: 403 });
  return { org: { id: orgId, slug: org.slug }, user: { id: userId, name: person.name } };
}
