import { getTrainerOrg } from "@/lib/org";

export const dynamic = "force-dynamic";

/** Who the copilot chat works for in this tab: the signed-in studio member and the org (pinned per tab when multi-org). */
export async function GET() {
  const org = await getTrainerOrg();
  if (!org) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ userId: org.user.id, orgId: org.id });
}
