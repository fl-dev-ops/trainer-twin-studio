import { db } from "@/lib/db";
import { isApiError, requireExternalApi } from "@/lib/external-api";

type Params = { params: Promise<{ slug: string }> };

/** Get one scenario, including its role-play configuration (`data`). Read-only:
 * scenario configuration itself stays dashboard-only. */
export async function GET(request: Request, { params }: Params) {
  const api = await requireExternalApi(request, "scenarios", "read");
  if (isApiError(api)) return api;
  const { slug } = await params;

  const scenario = await db.agent.findFirst({
    where: { orgId: api.org.id, slug },
    select: {
      slug: true,
      name: true,
      version: true,
      visibility: true,
      domainSlug: true,
      order: true,
      data: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { assignments: true } },
    },
  });
  if (!scenario) return Response.json({ error: "Scenario not found" }, { status: 404 });

  const { _count, ...rest } = scenario;
  return Response.json({ scenario: { ...rest, assignmentCount: _count.assignments } });
}
