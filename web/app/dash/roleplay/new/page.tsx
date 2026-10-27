import { RoleplayBuilderPage } from "@/components/roleplay/roleplay-builder-page";
import { roleplayServer } from "@/lib/roleplay/server";

export const dynamic = "force-dynamic";

const NOTHING_BEFORE = { preScreenshare: false, preUpload: false, duringUpload: false, uploadTitle: "", uploadInstruction: "" };

/** Build a new role play. */
export default async function NewRoleplayRoute() {
  const roleplay = await roleplayServer();
  return <RoleplayBuilderPage before={NOTHING_BEFORE} personas={await roleplay.builder.personas()} />;
}
