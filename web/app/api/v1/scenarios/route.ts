import { db } from "@/lib/db";
import { paginationFromUrl, requireExternalApi, apiRoute } from "@/lib/external-api";

const listSelect = {
  slug: true,
  name: true,
  version: true,
  visibility: true,
  order: true,
  createdAt: true,
  updatedAt: true,
  // Learners currently assigned: pending or used (cancelled and expired ones don't count).
  deployments: { select: { _count: { select: { assignments: { where: { status: { in: ["pending", "used"] as string[] } } } } } } },
} as const;

/** List the organization's published (not archived) role-play scenarios, in dashboard order. Read-only: scenario
 * configuration itself stays dashboard-only. Twins are not part of the public API. */
async function handleGET(request: Request) {
  const api = await requireExternalApi(request, "scenarios", "read");
  const page = paginationFromUrl(new URL(request.url));

  const [scenarios, total] = await Promise.all([
    db.agent.findMany({
      where: { orgId: api.org.id, kind: "ROLEPLAY", archivedAt: null },
      orderBy: [{ order: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      skip: page.offset,
      take: page.limit,
      select: listSelect,
    }),
    db.agent.count({ where: { orgId: api.org.id, kind: "ROLEPLAY", archivedAt: null } }),
  ]);

  return Response.json({
    scenarios: scenarios.map(({ deployments, ...scenario }) => ({ ...scenario, assignmentCount: deployments[0]?._count.assignments ?? 0 })),
    pagination: { ...page, total },
  });
}

export const GET = apiRoute(handleGET);
