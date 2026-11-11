import { AppError, errorResponse } from "@/lib/errors";
import { orgPerson } from "@/lib/org-people";
import { db } from "@/lib/db";
import { copilotStudioInput, runCopilotStudio } from "@/lib/copilot-studio";
import { isStudioRole } from "@/lib/org";
import { ingestAuthorized, ScenarioIngestError } from "@/lib/scenario-ingest";
import { TwinAccessError } from "@/lib/twin-access";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The copilot's studio actions (lib/copilot-studio.ts): read twins, skills, role plays and knowledge; change settings;
 * invite learners; archive / restore. Bearer SCENARIO_INGEST_SECRET like the other copilot routes, plus
 * x-trainertwin-org-id (the copilot session's org) and x-trainertwin-user-id (the signed-in trainer the web proxy put on
 * the session). The user must be a studio member of that org.
 */
export async function POST(request: Request) {
  if (!ingestAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = request.headers.get("x-trainertwin-org-id")?.trim();
  const userId = request.headers.get("x-trainertwin-user-id")?.trim();
  if (!orgId || !userId) return Response.json({ error: "Organization and user are required" }, { status: 400 });

  const person = await orgPerson(orgId, { userId });
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  const member = person && !person.disabled && org ? { role: person.role, user: { name: person.name }, organization: org } : null;
  if (!member || !isStudioRole(member.role)) return Response.json({ error: "Only studio members can use the copilot" }, { status: 403 });

  const parsed = copilotStudioInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });

  try {
    const result = await runCopilotStudio(
      { org: { id: orgId, slug: member.organization.slug }, user: { id: userId, name: member.user.name } },
      parsed.data,
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    if (error instanceof ScenarioIngestError || error instanceof TwinAccessError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("[API:internal:copilot-studio] failed:", error);
    return Response.json({ error: "The studio action failed" }, { status: 500 });
  }
}
