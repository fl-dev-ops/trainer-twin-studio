import { TwinAvatarCapture } from "@/components/twin/twin-avatar-capture";
import { twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

/** The twin's avatar: a photo taken or uploaded, kept as is or as one of the AI versions made from it. */
export default async function TwinAvatarRoute() {
  const twin = await twinServer();
  const state = await twin.avatar.get();
  return <TwinAvatarCapture personaName={state?.personaName ?? null} />;
}
