import { RoleplayLibraryPage } from "@/components/roleplay/roleplay-library-page";
import { roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

/** Scenarios — the role-play library. */
export default async function RoleplayPage() {
  const roleplay = await roleplayServer();
  return <RoleplayLibraryPage scenarios={await roleplay.scenarios.list()} />;
}
