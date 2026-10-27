import { RoleplayDetailPage } from "@/components/roleplay/roleplay-detail-page";
import { orNotFound, roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

/** One role play: client, scenario, report, members, sessions. */
export default async function RoleplayDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roleplay = await roleplayServer();
  return <RoleplayDetailPage roleplay={await orNotFound(roleplay.scenarios.get({ slug: id }))} />;
}
