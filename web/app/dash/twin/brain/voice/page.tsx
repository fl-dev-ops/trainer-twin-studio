import { TwinVoiceCapture } from "@/components/twin/twin-voice-capture";
import { twinServer } from "@/lib/twin/server";

export const dynamic = "force-dynamic";

/** The twin's voice, recorded on camera: the take's audio clones the voice, its video is the AI avatar reference. */
export default async function TwinVoiceRoute() {
  const twin = await twinServer();
  const state = await twin.avatar.get();
  return <TwinVoiceCapture personaName={state?.personaName ?? null} />;
}
