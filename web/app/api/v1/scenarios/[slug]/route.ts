import { errorResponse, refusals } from "@/lib/errors";
import { db } from "@/lib/db";
import { requireExternalApi, apiRoute } from "@/lib/external-api";

type Params = { params: Promise<{ slug: string }> };

/** Get one scenario, including its role-play configuration (`data`). Read-only:
 * scenario configuration itself stays dashboard-only. A twin or an archived role play answers like an unknown scenario. */
async function handleGET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "scenarios", "read");
  const { slug } = await params;

  const scenario = await db.agent.findFirst({
    where: { orgId: api.org.id, slug, kind: "ROLEPLAY", archivedAt: null },
    select: {
      slug: true,
      name: true,
      version: true,
      visibility: true,
      order: true,
      data: true,
      createdAt: true,
      updatedAt: true,
      deployments: { select: { _count: { select: { assignments: { where: { status: { in: ["pending", "used"] } } } } } } },
    },
  });
  if (!scenario) return errorResponse(refusals.notFound());

  const { deployments, ...rest } = scenario;
  return Response.json({ scenario: { ...rest, assignmentCount: deployments[0]?._count.assignments ?? 0 } });
}

export const GET = apiRoute(handleGET);
