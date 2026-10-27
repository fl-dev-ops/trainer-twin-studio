import { RoleplayUsersPage } from "@/components/roleplay/roleplay-users-page";
import { roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

/** Roleplay users: everyone invited to or practising on the org's role plays. */
export default async function RoleplayUsersRoute() {
  const roleplay = await roleplayServer();
  return <RoleplayUsersPage users={await roleplay.users.list()} />;
}
