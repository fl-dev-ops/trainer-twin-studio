import { RoleplayAssignPage } from "@/components/roleplay/roleplay-assign-page";
import { orNotFound, roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

/** Assign a role play by email. */
export default async function RoleplayAssignRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roleplay = await roleplayServer();
  return <RoleplayAssignPage roleplay={await orNotFound(roleplay.scenarios.get({ slug: id }))} />;
}
