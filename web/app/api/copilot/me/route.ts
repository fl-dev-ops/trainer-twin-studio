import { studioOrRefusal } from "@/lib/org";

export const dynamic = "force-dynamic";

/** Who the copilot chat works for in this tab: the signed-in studio member and the org (pinned per tab when multi-org). */
export async function GET() {
  const org = await studioOrRefusal();
  if (org instanceof Response) return org;
  return Response.json({ userId: org.user.id, orgId: org.id });
}
