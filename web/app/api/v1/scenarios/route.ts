import { db } from "@/lib/db";
import { isApiError, requireExternalApi } from "@/lib/external-api";

const listSelect = {
  slug: true,
  name: true,
  version: true,
  visibility: true,
  domainSlug: true,
  order: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { assignments: true } },
} as const;

/** List the organization's published role-play scenarios. Read-only: scenario
 * configuration itself stays dashboard-only. */
export async function GET(request: Request) {
  const api = await requireExternalApi(request, "scenarios", "read");
  if (isApiError(api)) return api;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const [scenarios, total] = await Promise.all([
    db.agent.findMany({
      where: { orgId: api.org.id },
      orderBy: [{ order: "asc" }, { createdAt: "desc" }],
      skip: offset,
      take: limit,
      select: listSelect,
    }),
    db.agent.count({ where: { orgId: api.org.id } }),
  ]);

  return Response.json({
    scenarios: scenarios.map(({ _count, ...scenario }) => ({ ...scenario, assignmentCount: _count.assignments })),
    pagination: { limit, offset, total },
  });
}
