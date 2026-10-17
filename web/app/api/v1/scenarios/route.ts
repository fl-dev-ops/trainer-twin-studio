import { db } from "@/lib/db";
import { isApiError, paginationFromUrl, requireExternalApi } from "@/lib/external-api";

const listSelect = {
  slug: true,
  name: true,
  version: true,
  visibility: true,
  domainSlug: true,
  order: true,
  createdAt: true,
  updatedAt: true,
  deployments: { select: { _count: { select: { assignments: true } } } },
} as const;

/** List the organization's published role-play scenarios. Read-only: scenario
 * configuration itself stays dashboard-only. */
export async function GET(request: Request) {
  const api = await requireExternalApi(request, "scenarios", "read");
  if (isApiError(api)) return api;
  const page = paginationFromUrl(new URL(request.url));
  if (page instanceof Response) return page;

  const [scenarios, total] = await Promise.all([
    db.agent.findMany({
      where: { orgId: api.org.id },
      orderBy: [{ order: "asc" }, { createdAt: "desc" }],
      skip: page.offset,
      take: page.limit,
      select: listSelect,
    }),
    db.agent.count({ where: { orgId: api.org.id } }),
  ]);

  return Response.json({
    scenarios: scenarios.map(({ deployments, ...scenario }) => ({ ...scenario, assignmentCount: deployments[0]?._count.assignments ?? 0 })),
    pagination: { ...page, total },
  });
}
