import { RoleplaySessionsPage } from "@/components/roleplay/roleplay-sessions-page";
import { roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

/** Role play sessions: practice sessions on the org's role plays. */
export default async function RoleplaySessionsRoute() {
  const roleplay = await roleplayServer();
  return <RoleplaySessionsPage sessions={await roleplay.sessions.list()} />;
}
