import { RoleplayAssignPage } from "@/components/roleplay/roleplay-assign-page";
import { orNotFound, roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

/** Assign a role play: members, and the assign dialog over the org's learners. */
export default async function RoleplayAssignRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roleplay = await roleplayServer();
  const [detail, learners] = await Promise.all([orNotFound(roleplay.scenarios.get({ slug: id })), roleplay.users.orgLearners()]);
  return <RoleplayAssignPage roleplay={detail} learners={learners} />;
}
