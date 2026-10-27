import { TwinAvatarCapture } from "@/components/twin/twin-avatar-capture";
import { twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

/** Voice and avatar setup: a photo (the twin's face), then a video reading a passage (cloned voice + avatar reference). */
export default async function TwinAvatarRoute() {
  const twin = await twinServer();
  const state = await twin.avatar.get();
  return <TwinAvatarCapture personaName={state?.personaName ?? null} />;
}
